import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Page, Layout, Frame } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// ─── LOADER ────────────────────────────────────────────
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const query = `
    query {
      products(first: 10) {
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

// ─── ACTION (DELETE PRODUCT) ───────────────────────────
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = formData.get("id");

  const mutation = `
    mutation productDelete($input: ID!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const res = await admin.graphql(mutation, {
      variables: { input: id },
    });
    const result = await res.json();
    if (result.data.productDelete.userErrors.length > 0) {
      console.error(result.data.productDelete.userErrors);
    }
    return redirect("/app/products");
  } catch (error) {
    console.error("Delete failed:", error);
    return new Response("Error deleting product", { status: 500 });
  }
}

// ─── COMPONENT ─────────────────────────────────────────
export default function ProductListPage() {
  const { products, shop } = useLoaderData();
  const fetcher = useFetcher();

  return (
    <Frame>
      <Page title="Products">
        <Layout>
          <Layout.Section>
            <div style={{ background: "#fff", borderRadius: "8px", padding: "1rem" }}>
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

              {products.map(({ node }) => {
                const {
                  id,
                  title,
                  featuredImage,
                  status,
                  productType,
                  totalInventory,
                  vendor,
                } = node;

                const numericId = id.split("/").pop(); // extract product ID
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
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        style={{
                          padding: "4px 8px",
                          background: "#007bff",
                          color: "#fff",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                        }}
                        onClick={() => window.open(editUrl, "_blank")}
                      >
                        Update
                      </button>
                      <fetcher.Form method="post">
                        <input type="hidden" name="id" value={id} />
                        <button
                          type="submit"
                          style={{
                            padding: "4px 8px",
                            background: "#dc3545",
                            color: "#fff",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </fetcher.Form>
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
