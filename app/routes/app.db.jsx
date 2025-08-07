import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useActionData } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { PrismaClient } from "@prisma/client";
import {
  Page,
  Layout,
  Card,
  Select,
  Text,
  Spinner,
  ChoiceList,
  Button,
  DataTable,
  TextField,
  Banner,
} from "@shopify/polaris";

// NOTE: Ensure your PrismaClient and shopify.server paths are correct
const prisma = new PrismaClient();

// GraphQL query to fetch all collections with pagination
const COLLECTIONS_QUERY = `
  query getCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges { cursor node { id title } }
      pageInfo { hasNextPage }
    }
  }
`;

// GraphQL query to fetch a single page of products for a specific collection
const PRODUCTS_PAGE_QUERY = `
  query productsByCollectionWithPagination($collectionId: ID!, $first: Int!, $after: String) {
    node(id: $collectionId) {
      ... on Collection {
        id
        title
        products(first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              handle
              title
              variants(first: 10) {
                edges { node { id sku } }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

/**
 * Remix Loader function to fetch initial data based on URL parameters.
 * This is a highly flexible loader that responds to different query params
 * to fetch collections, products, spec keys, or spec values as needed by the UI.
 * @param {object} args - The Remix loader arguments.
 * @returns {Promise<Response>} A JSON response containing the requested data.
 */
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const collectionId = url.searchParams.get("collectionId");
    const skuListString = url.searchParams.get("skuList");
    const specKeysListString = url.searchParams.get("specKeys");

    let collections = [];
    let collectionCursor = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const res = await admin.graphql(COLLECTIONS_QUERY, {
        variables: { first: 100, after: collectionCursor },
      });
      const data = await res.json();
      const edges = data?.data?.collections?.edges || [];
      collections.push(...edges.map((e) => e.node));
      hasNextPage = data?.data?.collections?.pageInfo?.hasNextPage;
      if (hasNextPage) collectionCursor = edges[edges.length - 1].cursor;
    }

    // --- Scenario 1: Initial page load
    if (!collectionId && !skuListString && !specKeysListString) {
      return json({ collections });
    }

    // --- Scenario 2: Collection is selected, fetch products and SKUs
    if (collectionId && !skuListString && !specKeysListString) {
      const products = [];
      let hasMoreProducts = true;
      let cursor = null;
      const pageSize = 100;
      const maxProducts = 500;
      let count = 0;
      while (hasMoreProducts && count < maxProducts) {
        const res = await admin.graphql(PRODUCTS_PAGE_QUERY, {
          variables: { collectionId, first: pageSize, after: cursor },
        });
        const data = await res.json();
        const edges = data?.data?.node?.products?.edges || [];
        for (const { node } of edges) {
          if (count >= maxProducts) break;
          products.push({
            id: node.id,
            handle: node.handle,
            title: node.title,
            variants: node.variants.edges.map((v) => ({
              id: v.node.id,
              sku: v.node.sku,
            })),
          });
          count++;
        }
        hasMoreProducts = data?.data?.node?.products?.pageInfo?.hasNextPage;
        cursor = edges.length ? edges[edges.length - 1].cursor : null;
      }
      const skus = products.flatMap((p) => p.variants.map((v) => v.sku)).filter(Boolean);
      return json({ collections, products, skus });
    }

    // --- Scenario 3: SKUs are available, fetch unique spec keys
    if (skuListString && !specKeysListString) {
      const skus = skuListString.split(",").map((s) => s.trim()).filter(Boolean);
      if (!skus.length) return json({ collections, specKeys: [] });

      const rows = await prisma.specifications.findMany({
        where: { sku: { in: skus } },
        select: { spec_key: true },
        distinct: ["spec_key"],
      });
      const specKeys = rows.map((r) => r.spec_key);
      return json({ collections, specKeys });
    }

    // --- Scenario 4: SKUs and spec keys are selected, fetch values for the editable table
    if (skuListString && specKeysListString) {
      const skus = skuListString.split(",").map((s) => s.trim()).filter(Boolean);
      const specKeys = specKeysListString.split(",").map((s) => s.trim()).filter(Boolean);
      if (!skus.length || !specKeys.length) return json({ values: {} });

      const rows = await prisma.specifications.findMany({
        where: { sku: { in: skus }, spec_key: { in: specKeys } },
      });
      const values = {};
      for (const row of rows) {
        if (!values[row.sku]) values[row.sku] = {};
        values[row.sku][row.spec_key] = row.spec_value;
      }
      return json({ values });
    }

    // Default return
    return json({ collections });
  } catch (error) {
    console.error("[loader] Error:", error);
    return json({ collections: [], products: [], skus: [], specKeys: [] }, { status: 500 });
  }
}

/**
 * Remix Action function to handle form submissions and update metafields.
 * This function handles the "Save" action to persist the data to Shopify.
 * @param {object} args - The Remix action arguments.
 * @returns {Promise<Response>} A JSON response indicating the success or failure of the operation.
 */
export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();

    const collectionId = formData.get("collectionId");
    const selectedKeys = JSON.parse(formData.get("selectedKeys") || "[]");
    const valuesBySku = JSON.parse(formData.get("valuesBySku") || "{}");

    if (!collectionId || selectedKeys.length === 0 || Object.keys(valuesBySku).length === 0) {
      return json({ ok: false, error: "Missing required data" });
    }

    // 1. Update collection metafields Filter1..Filter20 to selected keys
    for (let i = 0; i < selectedKeys.length && i < 20; i++) {
      const input = {
        namespace: "filters",
        key: `filter${i + 1}`,
        ownerId: collectionId,
        type: "single_line_text_field",
        value: selectedKeys[i],
      };
      const result = await admin.graphql(
        `
          mutation metafieldUpsert($input: MetafieldInput!) {
            metafieldUpsert(input: $input) {
              metafield { id }
              userErrors { field message }
            }
          }
        `,
        { variables: { input } }
      );
      const userErrors = result?.data?.metafieldUpsert?.userErrors;
      if (userErrors?.length) {
        console.error(`[action] Collection metafield update errors filter${i + 1}:`, userErrors);
      }
    }

    // 2. Map SKU to productId using your variants table
    const skus = Object.keys(valuesBySku);
    const variantRows = await prisma.variants.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, productId: true },
    });
    const skuToProductId = {};
    for (const v of variantRows) skuToProductId[v.sku] = v.productId;

    // 3. Update product metafields Filter1..Filter20 with corresponding values
    for (const [sku, keyValues] of Object.entries(valuesBySku)) {
      const productId = skuToProductId[sku];
      if (!productId) {
        console.warn(`[action] No productId found for SKU: ${sku}`);
        continue;
      }
      for (let i = 0; i < selectedKeys.length && i < 20; i++) {
        const val = keyValues[selectedKeys[i]] || "";
        const input = {
          namespace: "filters",
          key: `filter${i + 1}`,
          ownerId: productId,
          type: "single_line_text_field",
          value: val,
        };
        const result = await admin.graphql(
          `
            mutation metafieldUpsert($input: MetafieldInput!) {
              metafieldUpsert(input: $input) {
                metafield { id }
                userErrors { field message }
              }
            }
          `,
          { variables: { input } }
        );
        const userErrors = result?.data?.metafieldUpsert?.userErrors;
        if (userErrors?.length) {
          console.error(`[action] Product SKU:${sku} metafield update errors filter${i + 1}:`, userErrors);
        }
      }
    }
    return json({ ok: true });
  } catch (error) {
    console.error("[action] Error:", error);
    return json({ ok: false, error: "Failed to update metafields" }, { status: 500 });
  }
}

/**
 * React UI component for the Spec Manager page.
 * @returns {JSX.Element} The Spec Manager page UI.
 */
export default function SpecManagerPage() {
  const { collections } = useLoaderData();
  
  // Using separate fetchers for each step of the process
  const productsFetcher = useFetcher();
  const specKeysFetcher = useFetcher();
  const specValuesFetcher = useFetcher();
  const actionFetcher = useFetcher();

  // State variables to manage the UI flow
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [allSKUs, setAllSKUs] = useState([]);
  const [selectedSpecKeys, setSelectedSpecKeys] = useState([]);
  const [showEditTable, setShowEditTable] = useState(false);
  const [editValues, setEditValues] = useState({});
  const [productNameBySku, setProductNameBySku] = useState({});

  // 1. When a collection is selected, fetch the products and SKUs
  useEffect(() => {
    if (selectedCollectionId) {
      productsFetcher.load(`?collectionId=${encodeURIComponent(selectedCollectionId)}`);
      // Reset all other states to start fresh
      setAllSKUs([]);
      setSelectedSpecKeys([]);
      setShowEditTable(false);
      setEditValues({});
      setProductNameBySku({});
      actionFetcher.data = null; // Clear previous action data
    } else {
        setAllSKUs([]);
        setSelectedSpecKeys([]);
        setShowEditTable(false);
        setEditValues({});
        setProductNameBySku({});
    }
  }, [selectedCollectionId]);

  // 2. When products are fetched, fetch the unique spec keys
  useEffect(() => {
    const data = productsFetcher.data;
    if (data?.skus?.length) {
      setAllSKUs(data.skus);
      // Map SKUs to product titles for the table
      const map = {};
      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          for (const v of p.variants) {
            if (v.sku) map[v.sku] = p.title;
          }
        }
      }
      setProductNameBySku(map);
      // Now fetch the unique spec keys from the database
      specKeysFetcher.load(`?skuList=${encodeURIComponent(data.skus.join(","))}`);
    } else {
      setAllSKUs([]);
      setSelectedSpecKeys([]);
      setProductNameBySku({});
    }
  }, [productsFetcher.data]);

  // 3. When spec values are fetched, show the editable table
  useEffect(() => {
    if (specValuesFetcher.data?.values) {
      setEditValues(specValuesFetcher.data.values);
      setShowEditTable(true);
    }
  }, [specValuesFetcher.data]);

  // Handler for the "Update" button
  const handleUpdate = () => {
    if (allSKUs.length > 0 && selectedSpecKeys.length > 0) {
      specValuesFetcher.load(
        `?skuList=${encodeURIComponent(allSKUs.join(","))}&specKeys=${encodeURIComponent(selectedSpecKeys.join(","))}`
      );
    }
  };

  // Handler for updating a value in the editable table
  const updateEditValue = (sku, key, value) => {
    setEditValues((prev) => ({
      ...prev,
      [sku]: { ...(prev[sku] || {}), [key]: value },
    }));
  };

  // Handler for the "Save" button
  const handleSave = () => {
    if (!selectedCollectionId || !selectedSpecKeys.length) return;
    const formData = new FormData();
    formData.append("collectionId", selectedCollectionId);
    formData.append("selectedKeys", JSON.stringify(selectedSpecKeys));
    formData.append("valuesBySku", JSON.stringify(editValues));

    // Submit the form data to the action function
    actionFetcher.submit(formData, { method: "post" });
  };

  // Format collections for the Polaris Select component
  const collectionOptions = [
    { label: "Select a collection...", value: "" },
    ...(collections || []).map((col) => ({ label: col.title, value: col.id })),
  ];

  // Format spec keys for the Polaris ChoiceList component
  const specKeyChoices = (specKeysFetcher.data?.specKeys || []).map((key) => ({
    label: key,
    value: key,
  }));

  // Create the rows for the DataTable
  const tableRows = allSKUs.map((sku) => [
    sku,
    productNameBySku[sku] || "",
    ...selectedSpecKeys.map((key) => (
      <TextField
        key={`${sku}-${key}`}
        value={editValues[sku]?.[key] || ""}
        onChange={(val) => updateEditValue(sku, key, val)}
        autoComplete="off"
      />
    )),
  ]);

  return (
    <Page title="Product Spec Manager">
      <Layout>
        {/* Banner to show success/failure of the save action */}
        {actionFetcher.data && (
          <Layout.Section>
            <Banner
              status={actionFetcher.data.ok ? "success" : "critical"}
              title={actionFetcher.data.ok ? "Saved successfully!" : actionFetcher.data.error || "Failed to save"}
            >
              {actionFetcher.data.ok ? "Metafields have been updated." : "Please check the console for more details."}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card sectioned>
            <Text variant="headingMd" as="h2">Step 1: Select a Collection</Text>
            <Select
              label="Collection"
              labelHidden
              options={collectionOptions}
              value={selectedCollectionId}
              onChange={setSelectedCollectionId}
              disabled={showEditTable}
            />
          </Card>
        </Layout.Section>

        {/* Loading spinner while fetching products */}
        {productsFetcher.state === "loading" && selectedCollectionId && (
          <Layout.Section>
            <Card sectioned>
              <div style={{ textAlign: "center" }}><Spinner /></div>
            </Card>
          </Layout.Section>
        )}

        {/* Step 2: Select Spec Keys after SKUs are loaded */}
        {allSKUs.length > 0 && !showEditTable && (
          <Layout.Section>
            <Card sectioned>
              <Text variant="headingMd" as="h2">Step 2: Select Spec Keys</Text>
              <Text variant="bodyMd" as="p" color="subdued">
                {`Found ${allSKUs.length} unique SKUs in this collection. Select the specification keys you want to manage.`}
              </Text>
              {specKeysFetcher.state === "loading" ? (
                <div style={{ textAlign: "center" }}><Spinner /></div>
              ) : (
                <>
                  <ChoiceList
                    allowMultiple
                    choices={specKeyChoices}
                    selected={selectedSpecKeys}
                    onChange={setSelectedSpecKeys}
                    titleHidden
                  />
                  {selectedSpecKeys.length > 0 && (
                    <div style={{ marginTop: '16px' }}>
                      <Button
                        primary
                        onClick={handleUpdate}
                        loading={specValuesFetcher.state === "loading"}
                      >
                        Update
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          </Layout.Section>
        )}

        {/* Step 3: Edit and Save Spec Values */}
        {showEditTable && (
          <Layout.Section>
            <Card
              sectioned
              title="Step 3: Edit and Save Spec Values"
              actions={[
                {
                  content: "Save",
                  primary: true,
                  onAction: handleSave,
                  loading: actionFetcher.state === "submitting",
                },
                {
                  content: "Cancel",
                  onAction: () => {
                    setShowEditTable(false);
                    setEditValues({});
                    setSelectedSpecKeys([]);
                  },
                },
              ]}
            >
              <div style={{ overflowX: 'auto' }}>
                <DataTable
                  columnContentTypes={["text", "text", ...selectedSpecKeys.map(() => "text")]}
                  headings={["SKU", "Product Name", ...selectedSpecKeys]}
                  rows={tableRows}
                />
              </div>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}