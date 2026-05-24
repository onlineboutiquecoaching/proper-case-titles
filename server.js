import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const SHOPIFY_API_VERSION = "2026-04";
const SCOPES = "read_products,write_products";
const APP_URL = "https://proper-case-titles.onrender.com";

const oauthStates = new Set();

app.get("/", (req, res) => {
  res.status(200).send(`
    <h1>Proper Case Titles app is running.</h1>
    <p>To authorize the app, visit:</p>
    <p><a href="/auth?shop=${process.env.SHOPIFY_SHOP}">/auth?shop=${process.env.SHOPIFY_SHOP}</a></p>
  `);
});

function normalizeShop(shop) {
  if (!shop) return "";

  return shop
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .trim()
    .toLowerCase();
}

function isValidShop(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

function verifyOAuthHmac(query) {
  const { hmac, signature, ...rest } = query;

  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(",") : rest[key];
      return `${key}=${value}`;
    })
    .join("&");

  const generatedHash = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  const hmacBuffer = Buffer.from(hmac, "utf8");
  const generatedBuffer = Buffer.from(generatedHash, "utf8");

  if (hmacBuffer.length !== generatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(hmacBuffer, generatedBuffer);
}

/**
 * Start OAuth install/authorization.
 * Visit:
 * https://proper-case-titles.onrender.com/auth?shop=knitted-belle.myshopify.com
 */
app.get("/auth", (req, res) => {
  const shop = normalizeShop(req.query.shop || process.env.SHOPIFY_SHOP);

  if (!isValidShop(shop)) {
    return res.status(400).send("Invalid shop domain.");
  }

  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.add(state);

  const redirectUri = `${APP_URL}/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state
    }).toString();

  return res.redirect(installUrl);
});

/**
 * OAuth callback.
 * Shopify sends us a temporary code here.
 * We exchange it for the Admin API access token.
 */
app.get("/auth/callback", async (req, res) => {
  try {
    const shop = normalizeShop(req.query.shop);
    const code = req.query.code;
    const state = req.query.state;

    if (!isValidShop(shop)) {
      return res.status(400).send("Invalid shop.");
    }

    if (!code) {
      return res.status(400).send("Missing OAuth code.");
    }

    if (!state || !oauthStates.has(state)) {
      return res.status(400).send("Invalid OAuth state. Start again from /auth.");
    }

    oauthStates.delete(state);

    if (!verifyOAuthHmac(req.query)) {
      return res.status(400).send("Invalid OAuth HMAC.");
    }

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });

    const text = await tokenResponse.text();

    let tokenResult;
    try {
      tokenResult = JSON.parse(text);
    } catch (error) {
      return res.status(500).send(`
        <h1>Token exchange failed</h1>
        <p>Shopify did not return JSON.</p>
        <pre>${text.slice(0, 1000)}</pre>
      `);
    }

    if (!tokenResponse.ok || !tokenResult.access_token) {
      return res.status(500).send(`
        <h1>Token exchange failed</h1>
        <pre>${JSON.stringify(tokenResult, null, 2)}</pre>
      `);
    }

    return res.status(200).send(`
      <h1>Success — copy this token into Render</h1>

      <p>Go to Render → proper-case-titles → Environment.</p>

      <p>Set this variable:</p>

      <pre>SHOPIFY_ADMIN_ACCESS_TOKEN=${tokenResult.access_token}</pre>

      <p>Then click Save, rebuild and deploy.</p>

      <p>After Render redeploys, test:</p>

      <pre>${APP_URL}/api/test-shopify</pre>

      <p>Then run:</p>

      <pre>${APP_URL}/api/run-proper-case?secret=${process.env.RUN_SECRET}&batchSize=50</pre>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);

    return res.status(500).send(`
      <h1>OAuth callback failed</h1>
      <pre>${error.message}</pre>
    `);
  }
});

async function shopifyGraphQL(query, variables = {}) {
  if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN === "unused") {
    throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN. Go through /auth first and paste the token into Render.");
  }

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const text = await response.text();

  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    console.error("Shopify GraphQL returned non-JSON response:", text.slice(0, 1000));
    throw new Error(`Shopify GraphQL request returned non-JSON. Status: ${response.status}.`);
  }

  if (result.errors) {
    console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
  }

  return result;
}

app.get("/api/test-shopify", async (req, res) => {
  try {
    const query = `
      query {
        shop {
          name
          myshopifyDomain
        }
        products(first: 5) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    `;

    const result = await shopifyGraphQL(query);

    return res.status(200).json({
      shopEnv: process.env.SHOPIFY_SHOP,
      hasAdminToken: Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN),
      result
    });
  } catch (error) {
    console.error("Shopify test error:", error);

    return res.status(500).json({
      error: "Shopify test failed",
      details: error.message
    });
  }
});

app.use(
  "/api/webhooks/products",
  express.raw({ type: "application/json" })
);

const KEEP_UPPERCASE = new Set([
  "USA",
  "US",
  "UK",
  "XL",
  "XS",
  "XXL",
  "XXXL",
  "2XL",
  "3XL",
  "4XL",
  "SKU",
  "POD",
  "SEO",
  "VIP",
  "CEO",
  "B2B",
  "B2C"
]);

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "vs",
  "with"
]);

function titleCaseWord(word, index, totalWords) {
  const clean = word.replace(/[^a-zA-Z0-9]/g, "");
  const upperClean = clean.toUpperCase();

  if (!clean) return word;

  if (KEEP_UPPERCASE.has(upperClean)) {
    return word.replace(clean, upperClean);
  }

  if (/^\d+[a-zA-Z]+$/.test(clean)) {
    return word.replace(clean, clean.toUpperCase());
  }

  const lower = word.toLowerCase();

  if (
    index !== 0 &&
    index !== totalWords - 1 &&
    SMALL_WORDS.has(lower)
  ) {
    return lower;
  }

  return lower.replace(/\b[a-z]/g, char => char.toUpperCase());
}

function toProperCase(title) {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word, index, words) => titleCaseWord(word, index, words.length))
    .join(" ");
}

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!hmacHeader || !process.env.SHOPIFY_WEBHOOK_SECRET) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");

  const digestBuffer = Buffer.from(digest, "utf8");
  const hmacBuffer = Buffer.from(hmacHeader, "utf8");

  if (digestBuffer.length !== hmacBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(digestBuffer, hmacBuffer);
}

async function updateProductTitle(productGid, newTitle) {
  const mutation = `
    mutation UpdateProductTitle($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    product: {
      id: productGid,
      title: newTitle
    }
  });

  if (result.data?.productUpdate?.userErrors?.length) {
    console.error(
      "Shopify user errors:",
      JSON.stringify(result.data.productUpdate.userErrors, null, 2)
    );
  }

  return result;
}

async function fixExistingProductTitlesBatch(cursor = null, batchSize = 50) {
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const updatedProducts = [];

  const query = `
    query GetProducts($cursor: String, $batchSize: Int!) {
      products(first: $batchSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query, {
    cursor,
    batchSize
  });

  if (result.errors) {
    return {
      scanned,
      updated,
      skipped,
      errors: errors + 1,
      hasNextPage: false,
      nextCursor: null,
      updatedProducts,
      shopifyErrors: result.errors
    };
  }

  const products = result.data?.products?.edges || [];

  for (const edge of products) {
    const product = edge.node;
    scanned++;

    const currentTitle = product.title;
    const properTitle = toProperCase(currentTitle);

    if (currentTitle === properTitle) {
      skipped++;
      continue;
    }

    try {
      const updateResult = await updateProductTitle(product.id, properTitle);

      const userErrors = updateResult.data?.productUpdate?.userErrors || [];

      if (userErrors.length) {
        errors++;
        updatedProducts.push({
          id: product.id,
          oldTitle: currentTitle,
          attemptedTitle: properTitle,
          errors: userErrors
        });
        continue;
      }

      updated++;

      updatedProducts.push({
        id: product.id,
        oldTitle: currentTitle,
        newTitle: properTitle
      });
    } catch (error) {
      errors++;
      console.error(`Failed to update ${currentTitle}:`, error);

      updatedProducts.push({
        id: product.id,
        oldTitle: currentTitle,
        attemptedTitle: properTitle,
        error: error.message
      });
    }
  }

  const pageInfo = result.data?.products?.pageInfo || {};

  return {
    scanned,
    updated,
    skipped,
    errors,
    hasNextPage: Boolean(pageInfo.hasNextPage),
    nextCursor: pageInfo.endCursor || null,
    updatedProducts
  };
}

app.get("/api/run-proper-case", async (req, res) => {
  try {
    const secret = req.query.secret;

    if (!process.env.RUN_SECRET || secret !== process.env.RUN_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    const cursor = req.query.cursor || null;
    const batchSize = Math.min(Number(req.query.batchSize || 50), 100);

    const result = await fixExistingProductTitlesBatch(cursor, batchSize);

    const nextUrl = result.hasNextPage
      ? `${APP_URL}/api/run-proper-case?secret=${encodeURIComponent(
          process.env.RUN_SECRET
        )}&batchSize=${batchSize}&cursor=${encodeURIComponent(result.nextCursor)}`
      : null;

    return res.status(200).json({
      message: result.hasNextPage
        ? "Batch complete. More products remain. Open the nextUrl to continue."
        : "Bulk title cleanup complete. No more products remain.",
      batchSize,
      ...result,
      nextUrl
    });
  } catch (error) {
    console.error("Bulk cleanup error:", error);

    return res.status(500).json({
      error: "Bulk cleanup failed.",
      details: error.message
    });
  }
});

app.get("/api/register-webhooks", async (req, res) => {
  try {
    const secret = req.query.secret;

    if (!process.env.RUN_SECRET || secret !== process.env.RUN_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    const callbackUrl = `${APP_URL}/api/webhooks/products`;

    const mutation = `
      mutation WebhookSubscriptionCreate(
        $topic: WebhookSubscriptionTopic!
        $webhookSubscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(
          topic: $topic
          webhookSubscription: $webhookSubscription
        ) {
          webhookSubscription {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const topics = ["PRODUCTS_CREATE", "PRODUCTS_UPDATE"];
    const results = [];

    for (const topic of topics) {
      const result = await shopifyGraphQL(mutation, {
        topic,
        webhookSubscription: {
          callbackUrl,
          format: "JSON"
        }
      });

      results.push({
        topic,
        result
      });
    }

    return res.status(200).json({
      message: "Webhook registration attempted.",
      callbackUrl,
      results
    });
  } catch (error) {
    console.error("Webhook registration error:", error);

    return res.status(500).json({
      error: "Webhook registration failed.",
      details: error.message
    });
  }
});

app.post("/api/webhooks/products", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.error("Invalid Shopify webhook signature");
      return res.status(401).send("Invalid webhook signature");
    }

    const product = JSON.parse(req.body.toString("utf8"));

    if (!product?.id || !product?.title) {
      return res.status(200).send("No product title found");
    }

    const currentTitle = product.title;
    const properTitle = toProperCase(currentTitle);

    if (currentTitle === properTitle) {
      return res.status(200).send("Title already formatted");
    }

    const productGid = `gid://shopify/Product/${product.id}`;

    await updateProductTitle(productGid, properTitle);

    return res.status(200).send(`Updated title to: ${properTitle}`);
  } catch (error) {
    console.error("Webhook error:", error);

    return res.status(500).send("Webhook failed");
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Proper Case Titles app running on port ${port}`);
});
