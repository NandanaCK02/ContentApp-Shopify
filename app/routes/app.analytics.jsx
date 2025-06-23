import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  Select,
  Button,
  Text,
} from "@shopify/polaris";
import { useState } from "react";

// ─── LOADER ───
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const productsRes = await admin.graphql(`
    query {
      products(first: 50) {
        edges {
          node {
            id
            title
            totalInventory
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }
  `);

  const raw = await productsRes.json();
  const products = raw?.data?.products?.edges?.map((e) => e.node) || [];

  return json({ products, shop });
};

// ─── COMPONENT ───
export default function AnalyticsPage() {
  const { products, shop } = useLoaderData();
  const [selectedId, setSelectedId] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);

  const handleChange = (value) => {
    setSelectedId(value);
    const found = products.find((p) => p.id === value);
    setSelectedProduct(found || null);
  };

  const extractProductId = (gid) => gid?.split("/").pop();
  const storeName = shop?.split(".")[0];
  const analyticsUrl = `https://admin.shopify.com/store/${storeName}/analytics`;

  const productOptions = products.map((p) => ({
    label: p.title,
    value: p.id,
  }));

  return (
    <Page title="Product Analytics">
      <Layout>
        {/* Product Select */}
        <Layout.Section>
          <Card sectioned title="Select a product">
            <Select
              label="Product"
              options={productOptions}
              onChange={handleChange}
              value={selectedId}
              placeholder="Choose a product"
            />

            {selectedId && (
              <div style={{ marginTop: "1rem" }}>
                <Button
                  primary
                  onClick={() => window.open(analyticsUrl, "_blank")}
                >
                  Visit Shopify Analytics Page
                </Button>
              </div>
            )}
          </Card>
        </Layout.Section>

        {/* Product Overview */}
        {selectedProduct && (
          <Layout.Section>
            <Card title="In-App Product Overview" sectioned>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                }}
              >
                <Text
                  variant="headingLg"
                  as="h2"
                  fontWeight="bold"
                  alignment="center"
                  style={{ textAlign: "center", marginBottom: "16px" }}
                >
                  {selectedProduct.title}
                </Text>

                {/* Each detail box */}
                <div style={detailBoxStyle}>
                  <span style={emojiStyle}>💰</span>
                  <Text variant="bodyMd">Price: ₹{selectedProduct.variants.edges[0]?.node?.price || "N/A"}</Text>
                </div>

                <div style={detailBoxStyle}>
                  <span style={emojiStyle}>📦</span>
                  <Text variant="bodyMd">Inventory: {selectedProduct.totalInventory}</Text>
                </div>

                <div style={detailBoxStyle}>
                  <span style={emojiStyle}>🆔</span>
                  <Text variant="bodyMd">Product ID: {extractProductId(selectedProduct.id)}</Text>
                </div>
              </div>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

// ─── STYLES ───
const detailBoxStyle = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "16px",
  backgroundColor: "#ffffff",
  border: "1px solid #dfe3e8",
  borderRadius: "8px",
  boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
};

const emojiStyle = {
  fontSize: "22px",
  width: "28px",
  textAlign: "center",
};
