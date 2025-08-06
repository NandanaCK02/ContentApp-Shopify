import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Select,
  TextField,
  Button,
  Text,
  Spinner,
  LegacyStack as Stack,
}
 from "@shopify/polaris";

const prisma = new PrismaClient();

// --- GraphQL Queries and Mutations ---
const COLLECTIONS_QUERY = `
  query getCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          title
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const PRODUCTS_BY_COLLECTION_QUERY = `
  query productsByCollection($collectionId: ID!) {
    node(id: $collectionId) {
      ... on Collection {
        id
        title
        products(first: 100) {
          edges {
            node {
              id
              handle
              title
              variants(first: 10) {
                edges {
                  node {
                    id
                    sku
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;


const METAFIELDS_UPDATE_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// --- Loader for initial data and dynamic fetching ---
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const collectionId = url.searchParams.get("collectionId");
    const sku = url.searchParams.get("sku");

    // --- Fetch products for a collection ---
    if (collectionId) {
      const res = await admin.graphql(PRODUCTS_BY_COLLECTION_QUERY, {
        variables: { collectionId },
      });

      const data = await res.json(); // ✅ FIXED HERE

      const productEdges = data?.data?.node?.products?.edges || [];

      const products = productEdges.map(({ node }) => ({
        id: node.id,
        handle: node.handle,
        title: node.title,
        variants: node.variants.edges.map((v) => ({
          id: v.node.id,
          sku: v.node.sku,
        })),
      }));

      return json({ products });
    }

    // --- Fetch specs for a SKU ---
    if (sku) {
      const rows = await prisma.specs.findMany({
        where: { sku },
        select: { spec_key: true, spec_value: true },
      });
      const specs = rows.reduce((acc, row) => {
        acc[row.spec_key] = row.spec_value;
        return acc;
      }, {});
      return json({ specs });
    }

    // --- Fetch all collections (initial load) ---
    let collections = [];
    let collectionCursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables = { first: 100, after: collectionCursor };
      const res = await admin.graphql(COLLECTIONS_QUERY, { variables });
      const data = await res.json();

      const edges = data?.data?.collections?.edges || [];
      collections.push(...edges.map((e) => e.node));

      hasNextPage = data?.data?.collections?.pageInfo?.hasNextPage;
      if (hasNextPage) {
        collectionCursor = edges[edges.length - 1].cursor;
      }
    }

    return json({ collections });

  } catch (error) {
    console.error("Loader error:", error);
    return json(
      {
        collections: [],
        products: [],
        specs: {},
        error: "Failed to load data",
      },
      { status: 500 }
    );
  }
}


// --- Action handler for form submissions (spec updates) ---
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const { _action, sku, spec_key, spec_value, ownerId } = Object.fromEntries(formData);

  if (_action !== "updateSpec") {
    return json({ success: false, error: "Invalid action" }, { status: 400 });
  }

  try {
    // 1. Update your database
    await prisma.specs.upsert({
      where: { sku_spec_key: { sku, spec_key } },
      create: { sku, spec_key, spec_value },
      update: { spec_value },
    });

    // 2. Update the Shopify metafield
    const variables = {
      metafields: [{
        ownerId,
        namespace: "custom",
        key: spec_key,
        type: "single_line_text_field",
        value: spec_value,
      }],
    };

    const result = await admin.graphql(METAFIELDS_UPDATE_MUTATION, { variables });
    const errors = result?.data?.metafieldsSet?.userErrors;

    if (errors && errors.length > 0) {
      console.error("Shopify Metafield API Error:", errors);
      return json({ success: false, error: errors[0].message }, { status: 500 });
    }

    return json({ success: true });
  } catch (error) {
    console.error("Action handler error:", error);
    return json({ success: false, error: "Server error" }, { status: 500 });
  }
}

// --- React Component ---
export default function SpecManagerPage() {
  const { collections } = useLoaderData();
  const productsFetcher = useFetcher();
  const specsFetcher = useFetcher();

  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [localSpecs, setLocalSpecs] = useState({});

  // Fetch products when a collection is selected
  useEffect(() => {
    if (selectedCollectionId) {
      productsFetcher.load(`?collectionId=${encodeURIComponent(selectedCollectionId)}`);
    } else {
      setSelectedProduct(null);
    }
  }, [selectedCollectionId]);

  // Fetch specs when a product is selected
  useEffect(() => {
    if (selectedProduct?.variants[0]?.sku) {
      specsFetcher.load(`?sku=${encodeURIComponent(selectedProduct.variants[0].sku)}`);
    } else {
      setLocalSpecs({});
    }
  }, [selectedProduct]);

  // Update local state with fetched products
  useEffect(() => {
    if (productsFetcher.data?.products) {
      // Clear previous product selection when a new collection is loaded
      setSelectedProduct(null);
    }
  }, [productsFetcher.data]);

  // Update local state with fetched specs
  useEffect(() => {
    if (specsFetcher.data?.specs) {
      setLocalSpecs(specsFetcher.data.specs);
    }
  }, [specsFetcher.data]);

  const handleSpecChange = (key, value) => {
    setLocalSpecs((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveSpec = (specKey) => {
    const formData = new FormData();
    formData.append("_action", "updateSpec");
    formData.append("sku", selectedProduct.variants[0].sku);
    formData.append("spec_key", specKey);
    formData.append("spec_value", localSpecs[specKey]);
    formData.append("ownerId", selectedProduct.variants[0].id);

    productsFetcher.submit(formData, { method: "POST" });
  };

  const collectionOptions = [
    { label: "Select a collection...", value: "" },
    ...collections.map((col) => ({ label: col.title, value: col.id })),
  ];

  return (
    <Page title="Product Spec Manager">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <Select
              label="Collection"
              options={collectionOptions}
              onChange={setSelectedCollectionId}
              value={selectedCollectionId}
            />
          </Card>
        </Layout.Section>
        
        {selectedCollectionId && (
          <Layout.Section>
            <Card sectioned title="Products">
              {productsFetcher.state === "loading" ? (
                <div style={{ textAlign: "center" }}><Spinner /></div>
              ) : (
                productsFetcher.data?.products && productsFetcher.data.products.length > 0 ? (
                  <ul style={{ listStyleType: "none", padding: 0 }}>
                    {productsFetcher.data.products.map((product) => (
                      <li
                        key={product.id}
                        onClick={() => setSelectedProduct(product)}
                        style={{
                          cursor: "pointer",
                          padding: "8px",
                          backgroundColor: selectedProduct?.id === product.id ? "#f0f6fd" : "white",
                          borderBottom: "1px solid #e1e3e5",
                        }}
                      >
                        <Text as="p" variant="bodyMd">
                          {product.title} (SKU: {product.variants[0]?.sku || "N/A"})
                        </Text>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Text as="p">No products found in this collection.</Text>
                )
              )}
            </Card>
          </Layout.Section>
        )}

        {selectedProduct && (
          <Layout.Section>
            <Card sectioned title={`Specs for ${selectedProduct.title}`}>
              {specsFetcher.state === "loading" ? (
                <div style={{ textAlign: "center" }}><Spinner /></div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Spec Key</th>
                      <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #ddd" }}>Spec Value</th>
                      <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #ddd" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(localSpecs).map((key) => (
                      <tr key={key}>
                        <td style={{ padding: "8px" }}><Text as="p" variant="bodyMd">{key}</Text></td>
                        <td style={{ padding: "8px" }}>
                          <TextField
                            value={localSpecs[key] || ""}
                            onChange={(value) => handleSpecChange(key, value)}
                          />
                        </td>
                        <td style={{ textAlign: "right", padding: "8px" }}>
                          <Button onClick={() => handleSaveSpec(key)}>Save</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}