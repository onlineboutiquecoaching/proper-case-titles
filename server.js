import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const SHOPIFY_API_VERSION = "2026-04";

app.get("/", (req, res) => {
  res.status(200).send("Proper Case Titles app is running.");
});

/**
 * Gets a fresh Shopify Admin API access token using your Dev Dashboard app credentials.
 *
 * Required Render environment variables:
 * - SHOPIFY_SHOP = knitted-belle.myshopify.com
 * - SHOPIFY_API_KEY = Client ID from Shopify Dev Dashboard
 * - SHOPIFY_API_SECRET = Secret from Shopify Dev Dashboard
 * - RUN_SECRET = fix-my-titles
 * - SHOPIFY_WEBHOOK_SECRET = Secret from Shopify Dev Dashboard
 */
let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getShopifyAccessToken() {
  const now = Date.now();

  if (cachedAccessToken && now < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", process.env.SHOPIFY_API_KEY || "");
  body.append("client_secret", process.env.SHOPIFY_API_SECRET || "");

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body
    }
  );

  const text = await response.text();

  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    console.error("Shopify returned non-JSON response:", text.slice(0, 1000));
    throw new Error(
      `Shopify token request returned non-JSON. Status: ${response.status}. Check SHOPIFY_SHOP, SHOPIFY_API_KEY, and SHOPIFY_API_SECRET.`
    );
  }

  if (!response.ok || !result.access_token) {
    console.error("Token request failed:", JSON.stringify(result, null, 2));
    throw new Error(
      result.error_description ||
        result.error ||
        "Could not generate Shopify access token"
    );
  }

  cachedAccessToken = result.access_token;
  tokenExpiresAt = now + ((result.expires_in || 86400) * 1000);

  return cachedAccessToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyAccessToken();

  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
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
    throw new Error(
      `Shopify GraphQL request returned non-JSON. Status: ${response.status}.`
    );
  }

  if (result.errors) {
    console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
  }

  return result;
}

/**
 * Test route.
 * After deploy, visit:
 * https://proper-case-titles.onrender.com/api/test-shopify
 */
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
      hasApiKey: Boolean(process.env.SHOPIFY_API_KEY),
      hasApiSecret: Boolean(process.env.SHOPIFY_API_SECRET),
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

/**
 * Webhook raw body parser.
 * This must stay BEFORE the webhook route.
 */
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

async function fixExistingProductTitles() {
  let hasNextPage = true;
  let cursor = null;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const updatedProducts = [];

  while (hasNextPage) {
    const query = `
      query GetProducts($cursor: String) {
        products(first: 100, after: $cursor) {
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

    const result = await shopifyGraphQL(query, { cursor });

    if (result.errors) {
      errors++;
      break;
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
      }
    }

    hasNextPage = result.data?.products?.pageInfo?.hasNextPage || false;
    cursor = result.data?.products?.pageInfo?.endCursor || null;
  }

  return {
    scanned,
    updated,
    skipped,
    errors,
    updatedProducts
  };
}

/**
 * Bulk run route.
 * After deploy, visit:
 * https://proper-case-titles.onrender.com/api/run-proper-case?secret=fix-my-titles
 */
app.get("/api/run-proper-case", async (req, res) => {
  try {
    const secret = req.query.secret;

    if (!process.env.RUN_SECRET || secret !== process.env.RUN_SECRET) {
      return res.status(401).send("Unauthorized");
    }

    const result = await fixExistingProductTitles();

    return res.status(200).json({
      message: "Bulk title cleanup complete.",
      ...result
    });
  } catch (error) {
    console.error("Bulk cleanup error:", error);

    return res.status(500).json({
      error: "Bulk cleanup failed.",
      details: error.message
    });
  }
});

/**
 * Webhook route for future product creates/updates.
 */
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
