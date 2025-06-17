import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Layout,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// Loader to fetch products from Shopify Admin API
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const query = `
    query {
      products(first: 10) {
        edges {
          node {
            id
            title
            descriptionHtml
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
    return json({ products });
  } catch (error) {
    console.error("Failed to fetch products:", error);
    throw new Response("Error fetching products", { status: 500 });
  }
}

// Component to display product list
export default function ProductListPage() {
  const { products } = useLoaderData();

  return (
    <Page title="Product List">
      <Layout>
        <Layout.Section>
          <Card>
            <ResourceList
              resourceName={{ singular: "product", plural: "products" }}
              items={products}
              renderItem={({ node }) => {
                const { id, title, descriptionHtml, featuredImage } = node;
                const media = featuredImage?.url ? (
                  <Thumbnail source={featuredImage.url} alt={title} />
                ) : (
                  <Thumbnail source="https://via.placeholder.com/100" alt="No image" />
                );

                return (
                  <ResourceItem id={id} media={media} accessibilityLabel={`View details for ${title}`}>
                    <h3 style={{ fontWeight: 600 }}>{title}</h3>
                    <div
                      style={{ marginTop: "0.5rem", color: "#666" }}
                      dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                    />
                  </ResourceItem>
                );
              }}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
