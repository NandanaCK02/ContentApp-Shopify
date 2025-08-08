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
  Text,
  Spinner,
  ChoiceList,
  Button,
  DataTable,
  TextField,
  Banner,
} from "@shopify/polaris";

const prisma = new PrismaClient();

const COLLECTIONS_QUERY = `
  query getCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges { cursor node { id title } }
      pageInfo { hasNextPage }
    }
  }
`;

const PRODUCTS_QUERY_WITH_METAFIELDS = `
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
                edges {
                  node {
                    id
                    sku
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

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
      if (hasNextPage && edges.length > 0) collectionCursor = edges[edges.length - 1].cursor;
      else break;
    }

    if (!collectionId && !skuListString && !specKeysListString) {
      return json({ collections });
    }

    if (collectionId && !skuListString && !specKeysListString) {
      const products = [];
      let hasMoreProducts = true;
      let cursor = null;
      const pageSize = 100;
      const maxProducts = 500;
      let count = 0;
      while (hasMoreProducts && count < maxProducts) {
        const res = await admin.graphql(PRODUCTS_QUERY_WITH_METAFIELDS, {
          variables: { collectionId, first: pageSize, after: cursor },
        });
        const data = await res.json();
        const collectionNode = data?.data?.node;
        const edges = collectionNode?.products?.edges || [];
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
        hasMoreProducts = collectionNode?.products?.pageInfo?.hasNextPage;
        cursor = edges.length ? edges[edges.length - 1].cursor : null;
      }
      const skus = products.flatMap((p) => p.variants.map((v) => v.sku)).filter(Boolean);
      const rows = await prisma.specifications.findMany({
        where: { sku: { in: skus } },
        select: { spec_key: true },
        distinct: ["spec_key"],
      });
      const specKeys = rows.map((r) => r.spec_key);
      return json({ collections, products, skus, specKeys });
    }

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
    return json({ collections });
  } catch (error) {
    console.error("[loader] Error:", error);
    return json({ collections: [], products: [], skus: [], specKeys: [], values: {} }, { status: 500 });
  }
}

export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const collectionId = formData.get("collectionId");
    const selectedKeys = JSON.parse(formData.get("selectedKeys") || "[]");
    const valuesBySku = JSON.parse(formData.get("valuesBySku") || "{}");
    const productsData = JSON.parse(formData.get("productsData") || "[]");

    if (!collectionId || !productsData || selectedKeys.length === 0 || Object.keys(valuesBySku).length === 0) {
      return json({ ok: false, error: "Missing required data" });
    }

    const skuToProductId = {};
    productsData.forEach(p => {
      p.variants.forEach(v => {
        if (v.sku) {
          skuToProductId[v.sku] = p.id;
        }
      });
    });

    const metafieldsToUpsert = [];
    selectedKeys.slice(0, 20).forEach((key, i) => {
      metafieldsToUpsert.push({
        namespace: "custom",//gentech for general tech
        key: `filter_${i + 1}`,
        ownerId: collectionId,
        type: "single_line_text_field",
        value: key,
      });
    });

    for (const [sku, keyValues] of Object.entries(valuesBySku)) {
      const productId = skuToProductId[sku];
      if (!productId) {
        console.warn(`[action] No productId found for SKU: ${sku}`);
        continue;
      }
      selectedKeys.slice(0, 20).forEach((key, i) => {
        const val = keyValues[key] || "";
        metafieldsToUpsert.push({
          namespace: "custom",//gentech for genraltech
          key: `filter_${i + 1}`,
          ownerId: productId,
          type: "single_line_text_field",
          value: val,
        });
      });
    }

    if (metafieldsToUpsert.length > 0) {
      const result = await admin.graphql(
        `
          mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields { id }
              userErrors { field message }
            }
          }
        `,
        { variables: { metafields: metafieldsToUpsert } }
      );
      const data = await result.json();
      const userErrors = data?.data?.metafieldsSet?.userErrors;
      if (userErrors?.length) {
        console.error("[action] Metafield update errors:", userErrors);
        return json({ ok: false, error: userErrors[0].message }, { status: 500 });
      }
    }

    const dbUpdates = [];
    for (const [sku, keyValues] of Object.entries(valuesBySku)) {
      for (const [specKey, specValue] of Object.entries(keyValues)) {
        dbUpdates.push(
          prisma.specifications.upsert({
            where: {
              sku_spec_key: {
                sku,
                spec_key: specKey,
              },
            },
            update: { spec_value: specValue || "" },
            create: {
              sku,
              spec_key: specKey,
              spec_value: specValue || "",
            },
          })
        );
      }
    }
    if (dbUpdates.length > 0) {
      await prisma.$transaction(dbUpdates);
    }
    
    return json({ ok: true, message: "Saved successfully!" });
  } catch (error) {
    console.error("[action] Error:", error);
    return json({ ok: false, error: "Failed to update metafields and database" }, { status: 500 });
  }
}

export default function SpecManagerPage() {
  const { collections } = useLoaderData();
  const productsFetcher = useFetcher();
  const specValuesFetcher = useFetcher();
  const actionFetcher = useFetcher();

  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [allSKUs, setAllSKUs] = useState([]);
  const [availableSpecKeys, setAvailableSpecKeys] = useState([]);
  const [selectedSpecKeys, setSelectedSpecKeys] = useState([]);
  const [showEditTable, setShowEditTable] = useState(false);
  const [editValues, setEditValues] = useState({});
  const [productNameBySku, setProductNameBySku] = useState({});
  const [productsData, setProductsData] = useState([]);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  // Updated effect with minimal fix — no resetting selectedCollectionId here
  useEffect(() => {
    if (actionFetcher.data?.ok) {
      setShowSuccessBanner(true);
      setShowEditTable(false); // Hide edit table on success
      setEditValues({});
      setSelectedSpecKeys([]);
      setProductsData([]);
      setAllSKUs([]);
      setAvailableSpecKeys([]);
      setProductNameBySku({});
      // Do NOT reset selected collection here — allow user to select same or another collection again
      // actionFetcher.data = null; // Optional: clear fetcher data after handling if needed
    }
    if (actionFetcher.data && !actionFetcher.data.ok) {
      setShowSuccessBanner(false);
    }
  }, [actionFetcher.data]);


  useEffect(() => {
    if (!selectedCollectionId) {
      setAllSKUs([]);
      setAvailableSpecKeys([]);
      setSelectedSpecKeys([]);
      setShowEditTable(false);
      setEditValues({});
      setProductNameBySku({});
      setProductsData([]);
      setShowSuccessBanner(false);
      return;
    }
    productsFetcher.load(`?collectionId=${encodeURIComponent(selectedCollectionId)}`);
    setAllSKUs([]);
    setAvailableSpecKeys([]);
    setSelectedSpecKeys([]);
    setShowEditTable(false);
    setEditValues({});
    setProductNameBySku({});
    setProductsData([]);
    setShowSuccessBanner(false);
  }, [selectedCollectionId]);

  useEffect(() => {
    const data = productsFetcher.data;
    if (data && data.skus) {
      setAllSKUs(data.skus);
      setAvailableSpecKeys(data.specKeys);
      setProductsData(data.products);
      const map = {};
      if (Array.isArray(data.products)) {
        for (const p of data.products) {
          for (const v of p.variants) {
            if (v.sku) map[v.sku] = p.title;
          }
        }
      }
      setProductNameBySku(map);
    }
  }, [productsFetcher.data]);

  useEffect(() => {
    if (specValuesFetcher.data?.values) {
      setEditValues(specValuesFetcher.data.values);
      setShowEditTable(true);
    }
  }, [specValuesFetcher.data]);

  useEffect(() => {
    setShowEditTable(false);
    setEditValues({});
  }, [selectedSpecKeys]);

  const handleUpdate = () => {
    if (allSKUs.length > 0 && selectedSpecKeys.length > 0) {
      specValuesFetcher.load(
        `?skuList=${encodeURIComponent(allSKUs.join(","))}&specKeys=${encodeURIComponent(selectedSpecKeys.join(","))}`
      );
    }
  };

  const updateEditValue = (sku, key, value) => {
    setEditValues((prev) => ({
      ...prev,
      [sku]: { ...(prev[sku] || {}), [key]: value },
    }));
  };

  const handleSave = () => {
    if (!selectedCollectionId || selectedSpecKeys.length === 0) return;
    const formData = new FormData();
    formData.append("collectionId", selectedCollectionId);
    formData.append("selectedKeys", JSON.stringify(selectedSpecKeys));
    formData.append("valuesBySku", JSON.stringify(editValues));
    formData.append("productsData", JSON.stringify(productsData));
    actionFetcher.submit(formData, { method: "post" });
  };

  const handleCancel = () => {
    setShowEditTable(false);
    setEditValues({});
    setSelectedSpecKeys([]);
  };

  // Disable collection select only while loading or submitting
  const shouldDisableCollectionSelect = productsFetcher.state === "loading" || actionFetcher.state === "submitting";

  const collectionOptions = [
    { label: "Select a collection...", value: "" },
    ...(collections || []).map((col) => ({ label: col.title, value: col.id })),
  ];

  const specKeyChoices = (availableSpecKeys || []).map((key) => ({
    label: key,
    value: key,
  }));

  const tableRows = allSKUs.map((sku) => [
    sku,
    productNameBySku[sku] || "",
    ...selectedSpecKeys.map((key) => (
      <TextField
        key={`${sku}-${key}`}
        value={editValues[sku]?.[key] || ""}
        onChange={(val) => updateEditValue(sku, key, val)}
        autoComplete="off"
        disabled={actionFetcher.state === "submitting"}
      />
    )),
  ]);

  return (
    <Page title="Product Spec Manager">
      <Layout>
        {showSuccessBanner && (
          <Layout.Section>
            <Banner status="success" title="Saved successfully!">
              Metafields and database have been updated.
            </Banner>
          </Layout.Section>
        )}
        {actionFetcher.data && !actionFetcher.data.ok && (
          <Layout.Section>
            <Banner status="critical" title={actionFetcher.data.error || "Failed to save"}>
              Please check the console for more details.
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
              disabled={shouldDisableCollectionSelect}
            />
          </Card>
        </Layout.Section>

        {productsFetcher.state === "loading" && selectedCollectionId && (
          <Layout.Section>
            <Card sectioned>
              <div style={{ textAlign: "center" }}><Spinner /></div>
            </Card>
          </Layout.Section>
        )}

        {allSKUs.length > 0 && !showEditTable && (
          <Layout.Section>
            <Card sectioned>
              <Text variant="headingMd" as="h2">Step 2: Select Spec Keys</Text>
              <Text variant="bodyMd" as="p" color="subdued">
                {`Found ${allSKUs.length} unique SKUs in this collection. Select the specification keys you want to manage.`}
              </Text>
              {availableSpecKeys.length > 0 ? (
                <>
                  <ChoiceList
                    allowMultiple
                    choices={specKeyChoices}
                    selected={selectedSpecKeys}
                    onChange={setSelectedSpecKeys}
                    titleHidden
                  />
                  {selectedSpecKeys.length > 0 && (
                    <div style={{ marginTop: 16 }}>
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
              ) : (
                <Text variant="bodyMd" as="p" color="subdued">
                  No specification keys found for the products in this collection.
                </Text>
              )}
            </Card>
          </Layout.Section>
        )}

        {showEditTable && (
          <Layout.Section>
            <Card sectioned title="Step 3: Edit and Save Spec Values">
              <div style={{ overflowX: "auto" }}>
                <DataTable
                  columnContentTypes={["text", "text", ...selectedSpecKeys.map(() => "text")]}
                  headings={["SKU", "Product Name", ...selectedSpecKeys]}
                  rows={tableRows}
                />
              </div>
              <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
                <Button
                  primary
                  onClick={handleSave}
                  loading={actionFetcher.state === "submitting"}
                  disabled={actionFetcher.state === "submitting"}
                >
                  Save
                </Button>
                <Button
                  onClick={handleCancel}
                  disabled={actionFetcher.state === "submitting"}
                >
                  Cancel
                </Button>
              </div>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
