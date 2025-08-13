import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page, Layout, Card, Text, Spinner, ChoiceList, Button, DataTable, TextField, Banner, Autocomplete
} from "@shopify/polaris";

// ------------------------------------
// GraphQL Queries & Mutations
// ------------------------------------
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
              variants(first: 10) { edges { node { id sku } } }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

const COLLECTION_FILTERS_QUERY = `
  query getCollectionFilters($collectionId: ID!) {
    node(id: $collectionId) {
      ... on Collection {
        id
        metafields(first: 50, namespace: "custom") {
          edges { node { key value namespace } }
        }
      }
    }
  }
`;

const COLLECTION_METAFIELDS_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on Collection {
        metafields(first: 100, namespace: "custom") {
          edges { node { key namespace } }
        }
      }
    }
  }
`;

const PRODUCT_METAFIELDS_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on Product {
        metafields(first: 100, namespace: "custom") {
          edges { node { key namespace } }
        }
      }
    }
  }
`;

// Shopify expects metafields array with ownerId, namespace, key
const BULK_DELETE_MUTATION = `
  mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { namespace key }
      userErrors { field message }
    }
  }
`;

const normalizeKey = (str) =>
  (str || "").trim().toLowerCase().replace(/\s+/g, " ");

// ------------------------------------
// Loader
// ------------------------------------
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const collectionId = url.searchParams.get("collectionId");
    const skuListString = url.searchParams.get("skuList");
    const specKeysListString = url.searchParams.get("specKeys");

    let collections = [];
    let cursor = null, hasNext = true;
    while (hasNext) {
      const res = await admin.graphql(COLLECTIONS_QUERY, { variables: { first: 100, after: cursor } });
      const data = await res.json();
      const edges = data?.data?.collections?.edges || [];
      collections.push(...edges.map(e => e.node));
      hasNext = data?.data?.collections?.pageInfo?.hasNextPage;
      cursor = hasNext && edges.length ? edges[edges.length - 1].cursor : null;
    }

    if (!collectionId && !skuListString && !specKeysListString)
      return json({ collections });

    if (collectionId && !skuListString && !specKeysListString) {
      let products = [];
      let cur = null, hasMore = true;
      while (hasMore && products.length < 500) {
        const pdata = await admin.graphql(PRODUCTS_QUERY_WITH_METAFIELDS,
          { variables: { collectionId, first: 100, after: cur } });
        const data = await pdata.json();
        const edges = data?.data?.node?.products?.edges || [];
        products.push(...edges.map(e => ({
          id: e.node.id,
          handle: e.node.handle,
          title: e.node.title,
          variants: e.node.variants.edges.map(v => ({ id: v.node.id, sku: v.node.sku }))
        })));
        hasMore = data?.data?.node?.products?.pageInfo?.hasNextPage;
        cur = edges.length ? edges[edges.length - 1].cursor : null;
      }

      const skus = products.flatMap(p => p.variants.map(v => v.sku)).filter(Boolean);
      const rows = await prisma.specifications.findMany({
        where: { sku: { in: skus } },
        select: { spec_key: true },
        distinct: ["spec_key"]
      });

      const excludedKeys = new Set(["brand", "sku", "type"]);
      const normalizedToOriginal = new Map();
      for (const r of rows) {
        const key = r.spec_key ? r.spec_key.trim() : "";
        const norm = normalizeKey(key);
        if (key && !excludedKeys.has(norm) && !normalizedToOriginal.has(norm)) {
          normalizedToOriginal.set(norm, key);
        }
      }
      const specKeys = Array.from(normalizedToOriginal.values())
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), "en", { sensitivity: "base" }));

      let preselectedKeys = [];
      try {
        const resFilters = await admin.graphql(COLLECTION_FILTERS_QUERY, { variables: { collectionId } });
        const filtersData = await resFilters.json();
        const allValues = (filtersData?.data?.node?.metafields?.edges || [])
          .map(e => e?.node?.value ? String(e.node.value).trim() : "")
          .filter(Boolean);
        const dedupe = new Set();
        for (const val of allValues) {
          const norm = normalizeKey(val);
          const original = normalizedToOriginal.get(norm);
          if (original && !dedupe.has(original)) dedupe.add(original);
        }
        preselectedKeys = Array.from(dedupe);
      } catch (e) {
        console.warn("[loader] Failed to fetch collection filters:", e);
      }

      return json({ collections, products, skus, specKeys, preselectedKeys });
    }

    if (skuListString && specKeysListString) {
      const skus = skuListString.split(",").map(s => s.trim()).filter(Boolean);
      const specKeysRaw = specKeysListString.split(",").map(s => s.trim()).filter(Boolean);
      if (!skus.length || !specKeysRaw.length) return json({ values: {} });

      const targetKeys = specKeysRaw.map(normalizeKey);
      const allRows = await prisma.specifications.findMany({ where: { sku: { in: skus } } });
      const filteredRows = allRows.filter(r => targetKeys.includes(normalizeKey(r.spec_key)));

      const values = {};
      for (const row of filteredRows) {
        if (!values[row.sku]) values[row.sku] = {};
        values[row.sku][row.spec_key.trim()] = row.spec_value;
      }
      return json({ values });
    }

    return json({ collections });
  } catch (err) {
    console.error("[loader] Error:", err);
    return json({ collections: [], products: [], skus: [], specKeys: [], values: {} }, { status: 500 });
  }
}

// ------------------------------------
// Action — deletes old metafields before upserting new ones
// ------------------------------------
export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const collectionId = formData.get("collectionId");
    const selectedKeys = JSON.parse(formData.get("selectedKeys") || "[]");
    const valuesBySku = JSON.parse(formData.get("valuesBySku") || "{}");
    const productsData = JSON.parse(formData.get("productsData") || "[]");

    if (!collectionId)
      return json({ ok: false, error: "Missing collectionId" });

    const skuToProductId = {};
    productsData.forEach(p => {
      p.variants.forEach(v => { if (v.sku) skuToProductId[v.sku] = p.id; });
    });

    // Delete all existing filter metafields from the collection
    const collRes = await admin.graphql(COLLECTION_METAFIELDS_QUERY, { variables: { id: collectionId } });
    const collData = await collRes.json();
    const collDeletes = (collData?.data?.node?.metafields?.edges || [])
      .filter(e => e.node.key.startsWith("filter_"))
      .map(e => ({ ownerId: collectionId, namespace: e.node.namespace, key: e.node.key }));
    
    if (collDeletes.length) {
      const delRes = await admin.graphql(BULK_DELETE_MUTATION, { variables: { metafields: collDeletes } });
      const delJson = await delRes.json();
      if (delJson?.data?.metafieldsDelete?.userErrors?.length) throw new Error(delJson.data.metafieldsDelete.userErrors[0].message);
    }

    // Delete all existing filter metafields from products
    for (const pid of Object.values(skuToProductId)) {
      const prodRes = await admin.graphql(PRODUCT_METAFIELDS_QUERY, { variables: { id: pid } });
      const prodData = await prodRes.json();
      const prodDeletes = (prodData?.data?.node?.metafields?.edges || [])
        .filter(e => e.node.key.startsWith("filter_"))
        .map(e => ({ ownerId: pid, namespace: e.node.namespace, key: e.node.key }));
      
      if (prodDeletes.length) {
        const delRes = await admin.graphql(BULK_DELETE_MUTATION, { variables: { metafields: prodDeletes } });
        const delJson = await delRes.json();
        if (delJson?.data?.metafieldsDelete?.userErrors?.length) throw new Error(delJson.data.metafieldsDelete.userErrors[0].message);
      }
    }

    // Prepare metafields to upsert (only for currently selected keys)
    const metafieldsToUpsert = [];
    selectedKeys.slice(0, 20).forEach((key, i) => {
      if (key?.trim()) {
        metafieldsToUpsert.push({
          namespace: "custom",
          key: `filter_${i + 1}`,
          ownerId: collectionId,
          type: "single_line_text_field",
          value: key.trim()
        });
      }
    });

    Object.entries(valuesBySku).forEach(([sku, keyValues]) => {
      const pid = skuToProductId[sku];
      if (!pid) return;
      selectedKeys.slice(0, 20).forEach((key, i) => {
        const val = keyValues[key]?.trim();
        if (val) {
          metafieldsToUpsert.push({
            namespace: "custom",
            key: `filter_${i + 1}`,
            ownerId: pid,
            type: "single_line_text_field",
            value: val
          });
        }
      });
    });

    // Upsert the new metafields
    if (metafieldsToUpsert.length) {
      const UPSERT_MUTATION = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }
      `;
      for (let i = 0; i < metafieldsToUpsert.length; i += 25) {
        const batch = metafieldsToUpsert.slice(i, i + 25);
        const res = await admin.graphql(UPSERT_MUTATION, { variables: { metafields: batch } });
        const jsonRes = await res.json();
        if (jsonRes?.data?.metafieldsSet?.userErrors?.length) throw new Error(jsonRes.data.metafieldsSet.userErrors[0].message);
      }
    }
    
    // START of corrected Prisma logic (without changing schema)
    // START of corrected Prisma logic (matching your schema)
const dbOps = [];
for (const [sku, kv] of Object.entries(valuesBySku)) {
  for (const [specKey, specValue] of Object.entries(kv)) {
    // Allow saving even if specValue is empty string
    const keyRecord = await prisma.specifications.findFirst({
      where: { sku, spec_key: specKey },
    });

    if (keyRecord) {
      // Update existing record
      dbOps.push(
        prisma.specifications.update({
          where: { id: keyRecord.id },
          data: { spec_value: specValue },
        })
      );
    } else {
      // Create new record
      dbOps.push(
        prisma.specifications.create({
          data: { sku, spec_key: specKey, spec_value: specValue },
        })
      );
    }
  }
}
await prisma.$transaction(dbOps);
// END of corrected Prisma logic

    // END of corrected Prisma logic

    return json({ ok: true, message: "Saved successfully!" });
  } catch (err) {
    console.error("[action] Error:", err);
    return json({ ok: false, error: err.message || "Failed to update metafields and database" }, { status: 500 });
  }
}

// ------------------------------------
// React Component - UI changes to support saving with no keys
// ------------------------------------
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

  const [collectionSearchQuery, setCollectionSearchQuery] = useState("");
  const filteredCollectionOptions = (collections || [])
    .map(c => ({ label: c.title, value: c.id }))
    .filter(opt => opt.label.toLowerCase().includes(collectionSearchQuery.toLowerCase()));
  const selectedCollectionOption = selectedCollectionId ? [selectedCollectionId] : [];

  const handleCollectionSelect = (selected) => {
    const value = Array.isArray(selected) && selected.length ? selected[0] : "";
    setSelectedCollectionId(value);
  };

  useEffect(() => {
    if (actionFetcher.data?.ok) {
      setShowSuccessBanner(true);
      setShowEditTable(false);
      setEditValues({});
      setSelectedSpecKeys([]);
      setProductsData([]);
      setAllSKUs([]);
      setAvailableSpecKeys([]);
      setProductNameBySku({});
    } else if (actionFetcher.data && !actionFetcher.data.ok) {
      setShowSuccessBanner(false);
    }
  }, [actionFetcher.data]);

  useEffect(() => {
    if (!selectedCollectionId) {
      setAllSKUs([]); setAvailableSpecKeys([]); setSelectedSpecKeys([]);
      setShowEditTable(false); setEditValues({}); setProductNameBySku({});
      setProductsData([]); setShowSuccessBanner(false);
      return;
    }
    productsFetcher.load(`?collectionId=${encodeURIComponent(selectedCollectionId)}`);
  }, [selectedCollectionId]);

  useEffect(() => {
    const data = productsFetcher.data;
    if (data && data.skus) {
      setAllSKUs(data.skus);
      setAvailableSpecKeys(data.specKeys);
      setProductsData(data.products);
      if (Array.isArray(data.preselectedKeys)) setSelectedSpecKeys(data.preselectedKeys);
      const map = {};
      (data.products || []).forEach(p => p.variants.forEach(v => { if (v.sku) map[v.sku] = p.title; }));
      setProductNameBySku(map);
    }
  }, [productsFetcher.data]);

  useEffect(() => {
    if (specValuesFetcher.data?.values) {
      setEditValues(specValuesFetcher.data.values);
      setShowEditTable(true);
    }
  }, [specValuesFetcher.data]);

  useEffect(() => { setShowEditTable(false); setEditValues({}); }, [selectedSpecKeys]);

  const handleUpdate = () => {
    specValuesFetcher.load(`?skuList=${encodeURIComponent(allSKUs.join(","))}&specKeys=${encodeURIComponent(selectedSpecKeys.join(","))}`);
  };

  const updateEditValue = (sku, key, value) => {
    setEditValues(prev => ({ ...prev, [sku]: { ...(prev[sku] || {}), [key]: value } }));
  };

  const handleSave = () => {
    if (!selectedCollectionId) return;
    const formData = new FormData();
    formData.append("collectionId", selectedCollectionId);
    formData.append("selectedKeys", JSON.stringify(selectedSpecKeys));
    formData.append("valuesBySku", JSON.stringify(editValues));
    formData.append("productsData", JSON.stringify(productsData));
    actionFetcher.submit(formData, { method: "post" });
  };

  const handleCancel = () => { setShowEditTable(false); setEditValues({}); setSelectedSpecKeys([]); };

  const shouldDisableCollectionSelect = productsFetcher.state === "loading" || actionFetcher.state === "submitting";
  const specKeyChoices = (availableSpecKeys || []).map(key => ({ label: key, value: key }));

  const tableRows = allSKUs.map(sku => [
    sku,
    productNameBySku[sku] || "",
    ...selectedSpecKeys.map(key => (
      <div key={`${sku}-${key}`} style={{ minWidth: "200px" }}>
        <TextField
          value={editValues[sku]?.[key] || ""}
          onChange={val => updateEditValue(sku, key, val)}
          autoComplete="off"
          disabled={actionFetcher.state === "submitting"}
        />
      </div>
    )),
  ]);

  return (
    <Page title="Filter Manager">
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
            <Banner status="critical" title={actionFetcher.data.error || "Failed to save"} />
          </Layout.Section>
        )}

        <Layout.Section>
          <Card sectioned>
            <Text variant="headingMd">Step 1: Select a Collection</Text>
            <Autocomplete
              allowMultiple={false}
              options={filteredCollectionOptions}
              selected={selectedCollectionOption}
              onSelect={handleCollectionSelect}
              loading={productsFetcher.state === "loading"}
              textField={
                <Autocomplete.TextField
                  label="Collection"
                  labelHidden
                  placeholder="Search collections..."
                  value={collectionSearchQuery}
                  onChange={setCollectionSearchQuery}
                  autoComplete="off"
                  disabled={shouldDisableCollectionSelect}
                />
              }
            />
            {selectedCollectionId && (
              <Text variant="bodyMd" color="subdued" style={{ marginTop: "8px" }}>
                Selected collection:{" "}
                <strong>{collections.find(c => c.id === selectedCollectionId)?.title || ""}</strong>
              </Text>
            )}
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
              <Text variant="headingMd">Step 2: Select Specification Keys</Text>
              <Text variant="bodyMd" color="subdued">
                {`Found ${allSKUs.length} unique SKUs in this collection. Select the specification keys you want to use for filtering.`}
              </Text>
              {availableSpecKeys.length > 0 ? (
                <>
                  <ChoiceList allowMultiple choices={specKeyChoices} selected={selectedSpecKeys} onChange={setSelectedSpecKeys} titleHidden />
                  <div style={{ marginTop: 16 }}>
                    <Button primary onClick={handleUpdate} loading={specValuesFetcher.state === "loading"}>Update</Button>
                  </div>
                </>
              ) : (
                <Text variant="bodyMd" color="subdued">No specification keys found for the products in this collection.</Text>
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
                <Button primary onClick={handleSave} loading={actionFetcher.state === "submitting"} disabled={actionFetcher.state === "submitting"}>Save</Button>
                <Button onClick={handleCancel} disabled={actionFetcher.state === "submitting"}>Cancel</Button>
              </div>
            </Card>
          </Layout.Section>
        )}

        {/* This block handles the case where no keys are selected, but you still need to save.
            It allows you to clear metafields from a collection without selecting any keys. */}
        {selectedCollectionId && !showEditTable && (
          <Layout.Section>
            <div style={{ marginTop: "16px" }}>
              <Button primary onClick={handleSave} loading={actionFetcher.state === "submitting"} disabled={actionFetcher.state === "submitting"}>Save to Clear Filters</Button>
            </div>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}