// app/routes/app.products.jsx

import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Frame, TextField, Button } from "@shopify/polaris";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";

// ─── LOADER: Fetch product data ──────────────────────────────
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const query = `
    query {
      products(first: 50) {
        edges {
          node {
            id
            title
            status
            productType
            vendor
            totalInventory
            featuredImage {
              url
            }
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(query);
    const data = await response.json();
    const products = data?.data?.products?.edges || [];
    return json({ products, shop: session.shop });
  } catch (error) {
    console.error("Failed to fetch products:", error);
    throw new Response("Error fetching products", { status: 500 });
  }
}

// ─── COMPONENT ────────────────────────────────────────────────
export default function ProductListPage() {
  const { products, shop } = useLoaderData();
  const allProducts = products.map(edge => edge.node);

  const [searchTerm, setSearchTerm] = useState("");
  const [filteredProducts, setFilteredProducts] = useState(allProducts);

  const handleSearch = () => {
    const term = searchTerm.toLowerCase();
    const filtered = allProducts.filter(product =>
      product.title.toLowerCase().includes(term)
    );
    setFilteredProducts(filtered);
  };

  // Optional: reset to full list when search is cleared
  useEffect(() => {
    if (searchTerm === "") {
      setFilteredProducts(allProducts);
    }
  }, [searchTerm, allProducts]);

  return (
    <Frame>
      <Page title="Products">
        <Layout>
          <Layout.Section>
            {/* Search Input */}
            <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
              <TextField
                label=""
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder="Search by product title"
                autoComplete="off"
              />
              <Button onClick={handleSearch} primary>
                Search
              </Button>
            </div>

            {/* Table Header */}
            <div
              style={{
                background: "#fff",
                borderRadius: "8px",
                padding: "1rem",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr",
                  paddingBottom: "0.5rem",
                  fontWeight: "600",
                  borderBottom: "2px solid #ccc",
                }}
              >
                <div>Product</div>
                <div>Status</div>
                <div>Inventory</div>
                <div>Category</div>
                <div>Vendor</div>
                <div>Actions</div>
              </div>

              {/* Product Rows */}
              {filteredProducts.map(product => {
                const {
                  id,
                  title,
                  featuredImage,
                  status,
                  productType,
                  totalInventory,
                  vendor,
                } = product;

                const numericId = id.split("/").pop();
                const editUrl = `https://${shop}/admin/products/${numericId}`;

                return (
                  <div
                    key={id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr",
                      padding: "1rem 0",
                      borderBottom: "1px solid #eee",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                      <img
                        src={featuredImage?.url || "https://via.placeholder.com/100"}
                        alt={title}
                        style={{
                          width: "50px",
                          height: "50px",
                          borderRadius: "4px",
                          objectFit: "cover",
                        }}
                      />
                      <div>
                        <div style={{ fontWeight: "bold" }}>{title}</div>
                        <div style={{ fontSize: "0.85rem", color: "#666" }}>Demo product</div>
                      </div>
                    </div>
                    <div>{status}</div>
                    <div>{totalInventory} in stock</div>
                    <div>{productType || "Uncategorized"}</div>
                    <div>{vendor || "N/A"}</div>
                    <div>
                      <Button onClick={() => window.open(editUrl, "_blank")}>
                        Update
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}
