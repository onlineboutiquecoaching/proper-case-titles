import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.get("/", (req, res) => {
  res.status(200).send("Proper Case Titles app is running.");
});

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

    const response = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
        },
        body: JSON.stringify({ query })
      }
    );

    const result = await response.json();

    return res.status(200).json({
      shopEnv: process.env.SHOPIFY_SHOP,
      hasToken: Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN),
      result
    });
  } catch (error) {
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
  "USA", "US", "UK", "XL", "XS", "XXL", "XXXL", "2XL", "3XL", "4XL",
  "SKU", "POD", "SEO", "VIP", "CEO", "B2B", "B2C"
]);

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from",
  "in", "into", "nor", "of", "on", "or", "per", "the", "to", "vs", "with"
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

  return crypto.timingSafeEqual(
    Buffer.from(digest, "utf8"),
    Buffer.from(hmacHeader, "utf8")
  );
}

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const result = await response.json();

  if (result.errors) {
    console.error("GraphQL errors:", JSON.stringify(result.errors, null, 2));
  }

  return result;
}

async function updateProductTitle(productGid, newTitle) {
  const mutation = `
    mutation UpdateProductTitle($input: ProductInput!) {
      productUpdate(input: $input) {
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
    input: {
      id: productGid,
      title: newTitle
    }
  });

  if (result.data?.productUpdate?.userErrors?.length) {
    console.error("Shopify user errors:", result.data.productUpdate.userErrors);
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
        await updateProductTitle(product.id, properTitle);
        updated++;

        updatedProducts.push({
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
    return res.status(500).send("Bulk cleanup failed.");
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
