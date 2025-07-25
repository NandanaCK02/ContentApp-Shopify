import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  Page, Layout, Card, Autocomplete, TextField, Button, Text
} from "@shopify/polaris";
import { useState, useCallback, useMemo, useEffect } from "react";

// === METAFIELD TYPE MAPS ===
const typeMap = {
  single_line_text_field: "single_line_text_field",
  multi_line_text_field: "multi_line_text_field",
  rich_text_field: "rich_text_field",
  number_integer: "number_integer",
  number_decimal: "number_decimal",
  boolean: "boolean",
  json: "json",
  date: "date",
  date_time: "date_time",
  money: "money",
  url: "url",
  color: "color",
  rating: "rating",
  dimension: "dimension",
  volume: "volume",
  weight: "weight",
  product_reference: "product_reference",
  variant_reference: "variant_reference",
  collection_reference: "collection_reference",
  file_reference: "file_reference",
  page_reference: "page_reference",
  customer_reference: "customer_reference",
  company_reference: "company_reference",
  metaobject_reference: "metaobject_reference",
  mixed_reference: "mixed_reference",
  "list.single_line_text_field": "list.single_line_text_field",
  "list.number_integer": "list.number_integer",
  "list.boolean": "list.boolean",
  "list.json": "list.json",
  "list.collection_reference": "list.collection_reference",
};

// === LOADER ===
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // Fetch all collections
  let collections = [];
  let collectionCursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const res = await admin.graphql(`
      {
        collections(first: 100${collectionCursor ? `, after: "${collectionCursor}"` : ""}) {
          edges { cursor node { id title } }
          pageInfo { hasNextPage }
        }
      }
    `);
    const data = await res.json();
    const edges = data?.data?.collections?.edges || [];
    collections.push(...edges.map(e => e.node));
    hasNextPage = data?.data?.collections?.pageInfo?.hasNextPage;
    if (hasNextPage) collectionCursor = edges[edges.length - 1].cursor;
  }

  // Fetch metafield definitions for collections
  let definitions = [];
  let defCursor = null;
  hasNextPage = true;
  while (hasNextPage) {
    const res = await admin.graphql(`
      {
        metafieldDefinitions(first: 100, ownerType: COLLECTION${defCursor ? `, after: "${defCursor}"` : ""}) {
          edges {
            cursor
            node {
              name
              namespace
              key
              type { name }
              id
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `);
    const data = await res.json();
    const edges = data?.data?.metafieldDefinitions?.edges || [];
    definitions.push(...edges.map(e => ({
      ...e.node,
      type: typeMap[e.node.type.name] || e.node.type.name,
      originalType: e.node.type.name,
    })));
    hasNextPage = data?.data?.metafieldDefinitions?.pageInfo?.hasNextPage;
    if (hasNextPage) defCursor = edges[edges.length - 1].cursor;
  }

  return json({ collections, definitions });
}

// === ACTION ===
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // --- BULK GET ---
  if (intent === "getMetafieldValuesBulk") {
    const definition = form.get("definition");
    const collectionIds = JSON.parse(form.get("collectionIds") || "[]");
    if (!definition || !Array.isArray(collectionIds) || collectionIds.length === 0) {
      return json({ success: false, errors: [{ message: "Definition and at least one collection required." }], intent });
    }
    const [namespace, key, originalType] = definition.split("___");
    const results = await Promise.all(collectionIds.map(async (collectionId) => {
      try {
        const res = await admin.graphql(`
          query getMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
            node(id: $ownerId) {
              ... on Collection {
                metafield(namespace: $namespace, key: $key) {
                  value
                }
              }
            }
          }
        `, { variables: { ownerId: collectionId, namespace, key } });
        const data = await res.json();
        const value = data?.data?.node?.metafield?.value;
        return { collectionId, value };
      } catch (err) {
        return { collectionId, value: null };
      }
    }));
    const values = {};
    for (const { collectionId, value } of results)
      values[collectionId] = value;
    return json({ success: true, values, originalType, intent });
  }

  // --- BULK SET ---
  if (intent === "updateMetafieldsBulk") {
    const definition = form.get("definition");
    const updates = JSON.parse(form.get("updates") || "[]");
    if (!definition || !Array.isArray(updates) || updates.length === 0) {
      return json({ success: false, errors: [{ message: "Definition and at least one update required." }], intent });
    }
    const [namespace, key, originalType] = definition.split("___");
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message }
        }
      }
    `;
    const results = await Promise.all(updates.map(async ({ collectionId, value }) => {
      if (!collectionId) return { collectionId, success: false, errors: [{ message: "Missing collectionId" }] };
      try {
        const variables = {
          metafields: [
            {
              ownerId: collectionId,
              namespace,
              key,
              type: originalType,
              value,
            },
          ],
        };
        const response = await admin.graphql(mutation, { variables });
        const result = await response.json();
        const userErrors = result?.data?.metafieldsSet?.userErrors || [];
        if (userErrors.length > 0) {
          return { collectionId, success: false, errors: userErrors };
        }
        return { collectionId, success: true };
      } catch (err) {
        return { collectionId, success: false, errors: [{ message: "Server error" }] };
      }
    }));
    const allSuccess = results.every(r => r.success);
    return json({ success: allSuccess, results, intent });
  }

  // --- SINGLE ROW UPDATE ---
  if (intent === "updateMetafield") {
    const collectionId = form.get("collectionId");
    const definition = form.get("definition");
    const value = form.get("value");
    if (!collectionId || !definition || value === null) {
      return json({ success: false, errors: [{ message: "Collection ID, definition, and value are required." }], intent: "updateMetafield" });
    }
    const [namespace, key, originalType] = definition.split("___");
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message }
        }
      }
    `;
    const variables = { metafields: [{
      ownerId: collectionId, namespace, key, type: originalType, value
    }]};
    try {
      const response = await admin.graphql(mutation, { variables });
      const result = await response.json();
      const userErrors = result?.data?.metafieldsSet?.userErrors || [];
      if (userErrors.length > 0) {
        return json({ success: false, errors: userErrors, intent: "updateMetafield", collectionId });
      }
      return json({ success: true, intent: "updateMetafield", collectionId });
    } catch (err) {
      return json({
        success: false,
        errors: [{ message: "Server error during metafield update." }],
        intent: "updateMetafield",
        collectionId,
      });
    }
  }

  // --- SINGLE CLEAR ---
  if (intent === "clearMetafield") {
    const collectionId = form.get("collectionId");
    const definition = form.get("definition");
    if (!collectionId || !definition) {
      return json({
        success: false,
        errors: [{ message: "Collection ID and definition required." }],
        intent
      }, { status: 400 });
    }
    const [namespace, key] = definition.split("___");
    const delRes = await admin.graphql(`
      mutation ($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, { variables: { metafields: [{ ownerId: collectionId, namespace, key }] } });
    const delData = await delRes.json();
    const errs = delData?.data?.metafieldsDelete?.userErrors || [];
    if (errs.length)
      return json({ success: false, errors: errs, intent, collectionId });
    return json({ success: true, intent, collectionId });
  }

  return json({ success: false, errors: [{ message: "Invalid action intent." }] });
}

// === CLIENT/UI COMPONENT ===
export default function CollectionMetafieldEditor() {
  const { collections, definitions } = useLoaderData();
  const fetcher = useFetcher();
  const [collectionSearch, setCollectionSearch] = useState("");
  const [selectedCollectionIds, setSelectedCollectionIds] = useState([]);
  const [selectedDef, setSelectedDef] = useState("");
  const [metafieldValues, setMetafieldValues] = useState({});
  const [listValues, setListValues] = useState({});
  const [bulkValue, setBulkValue] = useState("");
  const [bulkListValue, setBulkListValue] = useState([]);
  const [successMap, setSuccessMap] = useState({});
  const [errorMap, setErrorMap] = useState({});

  const definitionOptions = useMemo(() => [{
    label: "Select a metafield definition", value: "", disabled: true
  }].concat(definitions.map(def => ({
    label: `${def.name} (${def.namespace}.${def.key}) - ${def.type.replace(/_/g, ' ')}`,
    value: `${def.namespace}___${def.key}___${def.originalType}`,
    namespace: def.namespace,
    key: def.key,
    type: def.type,
    originalType: def.originalType,
  }))), [definitions]);
  const [defSearch, setDefSearch] = useState("");
  const filteredDefs = useMemo(() => {
    return definitionOptions.filter(def =>
      def.label.toLowerCase().includes(defSearch.toLowerCase())
    );
  }, [definitionOptions, defSearch]);
  const selectedDefObj = definitionOptions.find(d => d.value === selectedDef);
  const selectedType = selectedDefObj?.type || "";
  const selectedOriginalType = selectedDefObj?.originalType || "";
  const isListType = selectedType.startsWith("list.") && !["list.collection_reference"].includes(selectedType);
  const isJsonType = selectedType === "json";
  const isCollectionReference = selectedType === "collection_reference";
  const isListCollectionReference = selectedType === "list.collection_reference";

  const collectionOptions = useMemo(
    () => collections.map(col => ({ label: col.title, value: col.id })),
    [collections]
  );
  const filteredCollectionOptions = useMemo(() => {
    let options = collectionOptions.filter(opt => !selectedCollectionIds.includes(opt.value));
    return options.filter(option =>
      option.label.toLowerCase().includes(collectionSearch.toLowerCase())
    ).slice(0, 20);
  }, [collectionSearch, collectionOptions, selectedCollectionIds]);

  // ------- FETCH VALUES -------
  useEffect(() => {
    if (selectedCollectionIds.length && selectedDef) {
      fetcher.submit(
        {
          intent: "getMetafieldValuesBulk",
          collectionIds: JSON.stringify(selectedCollectionIds),
          definition: selectedDef,
        },
        { method: "post", action: "." }
      );
    } else {
      setMetafieldValues({});
      setListValues({});
      setSuccessMap({});
      setErrorMap({});
    }
  }, [selectedCollectionIds, selectedDef]);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "getMetafieldValuesBulk") {
      const fetched = fetcher.data.values || {};
      const newValues = {};
      const newListValues = {};
      for (const cid of selectedCollectionIds) {
        const v = fetched[cid];
        if (isListCollectionReference) {
          try {
            const arr = JSON.parse(v);
            newListValues[cid] = Array.isArray(arr) ? arr : [];
            newValues[cid] = "";
          } catch {
            newListValues[cid] = [];
            newValues[cid] = "";
          }
        } else if (isListType || (isJsonType && Array.isArray(v))) {
          try {
            const arr = JSON.parse(v);
            newListValues[cid] = Array.isArray(arr) && arr.length > 0 ? arr : [""];
            newValues[cid] = "";
          } catch {
            newListValues[cid] = [v];
            newValues[cid] = "";
          }
        } else {
          newValues[cid] = v || "";
          newListValues[cid] = [];
        }
      }
      setMetafieldValues(newValues);
      setListValues(newListValues);
    }
  }, [fetcher.data, isListType, isJsonType, isListCollectionReference, selectedCollectionIds]);

  useEffect(() => {
    if (fetcher.data?.intent === "updateMetafieldsBulk" && fetcher.data?.results) {
      const s = {}, e = {};
      fetcher.data.results.forEach(r => {
        if (r.success) s[r.collectionId] = true;
        else e[r.collectionId] = r.errors?.map(x => x.message).join(", ") || "Error";
      });
      setSuccessMap(s);
      setErrorMap(e);
    }
    if (fetcher.data?.intent === "updateMetafield" && fetcher.data?.collectionId) {
      if (fetcher.data.success) setSuccessMap((prev) => ({ ...prev, [fetcher.data.collectionId]: true }));
      else setErrorMap((prev) => ({ ...prev, [fetcher.data.collectionId]: fetcher.data.errors?.map(x => x.message).join(", ") || "Error" }));
    }
    if (fetcher.data?.intent === "clearMetafield" && fetcher.data?.collectionId) {
      const cid = fetcher.data.collectionId;
      if (fetcher.data.success) {
        setMetafieldValues(prev => ({ ...prev, [cid]: "" }));
        setListValues(prev => ({ ...prev, [cid]: isListCollectionReference ? [] : [""] }));
        setSuccessMap(prev => ({ ...prev, [cid]: true }));
        setErrorMap(prev => ({ ...prev, [cid]: undefined }));
      } else {
        setErrorMap(prev => ({
          ...prev,
          [cid]: fetcher.data.errors?.map(e => e.message).join(", ") || "Error",
        }));
      }
    }
  }, [fetcher.data]);

  // ---------- Handler swaps --------------
  const handleCollectionSelect = useCallback(
    (selected) => {
      setSelectedCollectionIds((prev) => Array.from(new Set([...prev, ...selected])));
      setCollectionSearch("");
    },
    []
  );
  const handleRemoveCollection = (cid) => {
    setSelectedCollectionIds((prev) => prev.filter(id => id !== cid));
    setMetafieldValues((prev) => {
      const copy = { ...prev }; delete copy[cid]; return copy;
    });
    setListValues((prev) => {
      const copy = { ...prev }; delete copy[cid]; return copy;
    });
    setSuccessMap((prev) => {
      const copy = { ...prev }; delete copy[cid]; return copy;
    });
    setErrorMap((prev) => {
      const copy = { ...prev }; delete copy[cid]; return copy;
    });
  };

  // --------- Field changes ---------
  const handleValueChange = (collectionId, val) => {
    setMetafieldValues((prev) => ({ ...prev, [collectionId]: val }));
  };
  const handleListValueChange = (collectionId, data) => {
    setListValues((prev) => ({
      ...prev,
      [collectionId]: Array.isArray(data) ? data : [data]
    }));
  };
  const handleAddListItem = (collectionId) => {
    setListValues((prev) => ({
      ...prev,
      [collectionId]: [...(prev[collectionId] || [""]), ""],
    }));
  };
  const handleRemoveListItem = (collectionId, idx) => {
    setListValues((prev) => {
      const arr = [...(prev[collectionId] || [""])];
      arr.splice(idx, 1);
      return { ...prev, [collectionId]: arr.length > 0 ? arr : [""] };
    });
  };

  // --------- BULK SET -----------
  const handleBulkSet = () => {
    if (isListCollectionReference) {
      selectedCollectionIds.forEach(cid => setListValues((prev) => ({ ...prev, [cid]: bulkListValue })));
    } else if (isListType || (isJsonType && Array.isArray(bulkListValue))) {
      const updatedListValues = {};
      selectedCollectionIds.forEach(cid => {
        const clean = bulkListValue.filter(v => v && v.trim() !== "");
        updatedListValues[cid] = clean.length > 0 ? clean : [""];
      });
      setListValues(updatedListValues);
    } else {
      const newVals = {};
      selectedCollectionIds.forEach(cid => { newVals[cid] = bulkValue; });
      setMetafieldValues(newVals);
    }
  };

  // --------- BULK SUBMIT ----------
  const handleBulkSubmit = (e) => {
    e.preventDefault();
    const updates = selectedCollectionIds.map(cid => {
      let value = "";
      if (isListCollectionReference) {
        value = JSON.stringify(listValues[cid] || []);
      } else if (isCollectionReference) {
        value = metafieldValues[cid] ?? "";
      } else if (isListType || (isJsonType && Array.isArray(listValues[cid]) && selectedOriginalType.startsWith("LIST."))) {
        const rawList = listValues[cid] || [""];
        const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
        value = JSON.stringify(cleanList.length > 0 ? cleanList : []);
      } else if (isJsonType) {
        value = metafieldValues[cid] ?? bulkValue ?? "";
        try { value = JSON.stringify(JSON.parse(value)); } catch { value = ""; }
      } else {
        value = metafieldValues[cid] ?? bulkValue ?? "";
      }
      return { collectionId: cid, value };
    });
    if (updates.length === 0 && selectedDef) {
      alert("No valid metafield values to save.");
      return;
    }
    fetcher.submit(
      {
        intent: "updateMetafieldsBulk",
        definition: selectedDef,
        updates: JSON.stringify(updates),
      },
      { method: "post", action: "." }
    );
  };

  // ---------- ROW SUBMIT -----------
  const handleRowUpdate = (collectionId) => {
    let value = metafieldValues[collectionId];
    if (isListCollectionReference) {
      value = JSON.stringify(listValues[collectionId] || []);
    } else if (isCollectionReference) {
      value = metafieldValues[collectionId] ?? "";
    } else if (isListType || (isJsonType && Array.isArray(listValues[collectionId]) && selectedOriginalType.startsWith("LIST."))) {
      const rawList = listValues[collectionId] || [""];
      const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
      value = JSON.stringify(cleanList.length > 0 ? cleanList : []);
    } else if (isJsonType && metafieldValues[collectionId]) {
      value = metafieldValues[collectionId];
      try { value = JSON.stringify(JSON.parse(value)); } catch (e) { alert("Invalid JSON format."); return; }
    }
    if (!value &&
      !(isListType || isJsonType || isCollectionReference || isListCollectionReference)
    ) {
      if (confirm("Value is empty. Do you want to clear this metafield?")) {
        handleRowClear(collectionId);
      }
      return;
    }
    fetcher.submit(
      { intent: "updateMetafield", collectionId, definition: selectedDef, value },
      { method: "post", action: "." }
    );
  };
  const handleRowClear = (collectionId) => {
    fetcher.submit(
      { intent: "clearMetafield", collectionId, definition: selectedDef },
      { method: "post", action: "." }
    );
  };

  // === UI ===
  return (
<Page title="Collection Metafield Bulk Editor">
  <Layout>
    <Layout.Section>
      <Card sectioned>
        <form onSubmit={handleBulkSubmit}>
          {/* Selected Collection Chips */}
          {selectedCollectionIds.length > 0 && (
            <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {selectedCollectionIds.map(cid => {
                const col = collectionOptions.find(p => p.value === cid);
                return (
                  <span key={cid} style={{
                    display: "inline-flex",
                    alignItems: "center",
                    background: "#efcdf8", color: "#222", fontWeight: 600,
                    borderRadius: "16px", padding: "6px 14px 6px 12px", fontSize: "12px",
                    border: "1px solid #f59e42", marginRight: "4px",
                  }}>
                    {col?.label}
                    <button type="button" onClick={() => handleRemoveCollection(cid)}
                      style={{
                        background: "none", border: "none", color: "#d97706",
                        fontWeight: "bold", fontSize: "15px", marginLeft: "8px", cursor: "pointer",
                      }}
                      title="Remove"
                      aria-label="Remove"
                    >×</button>
                  </span>
                );
              })}
            </div>
          )}
          {/* Collection Multi-Select */}
          <div style={{ marginBottom: "1rem" }}>
            <Autocomplete
              options={filteredCollectionOptions}
              selected={[]}
              onSelect={handleCollectionSelect}
              allowMultiple
              textField={
                <Autocomplete.TextField
                  label="Search Collections"
                  value={collectionSearch}
                  onChange={setCollectionSearch}
                  placeholder="Search Collection Name"
                  autoComplete="off"
                />
              }
            />
          </div>
          {/* Definition Dropdown */}
          <div style={{ marginBottom: "1.5rem" }}>
            <Autocomplete
              options={filteredDefs}
              selected={selectedDef ? [selectedDef] : []}
              onSelect={selected => {
                setSelectedDef(selected[0] || "");
                setDefSearch("");
                setMetafieldValues({});
                setListValues({});
                setSuccessMap({});
                setErrorMap({});
              }}
              textField={
                <Autocomplete.TextField
                  label="Metafield Definition"
                  value={defSearch}
                  onChange={setDefSearch}
                  placeholder="Search metafield definitions"
                  clearButton
                  onClearButtonClick={() => setDefSearch("")}
                  autoComplete="off"
                />
              }
            />
          </div>
          {/* Show selected metafield info */}
          {selectedDefObj && (
            <Text style={{marginBottom: 12, color: '#444', display:"block"}}>
              Selected Metafield: <b>{selectedDefObj?.namespace}.{selectedDefObj?.key}</b> ({selectedDefObj?.type})
            </Text>
          )}
          {/* Bulk Set */}
          {selectedCollectionIds.length > 1 && selectedDef && (
            <div style={{ marginBottom: "1.5rem" }}>
              <Text as="p" variant="bodyMd" style={{ fontWeight: 700, color: "#97530bff", marginBottom: 8 }}>
                Bulk set value for all selected collections:
              </Text>
              {isListCollectionReference ? (
                <Autocomplete
                  options={collectionOptions}
                  selected={bulkListValue}
                  onSelect={vals => setBulkListValue(vals)}
                  allowMultiple
                  textField={
                    <Autocomplete.TextField
                      label="Select referenced collections"
                      value={bulkListValue.map(id => collectionOptions.find(opt => opt.value === id)?.label).filter(Boolean).join(", ")}
                      onChange={() => {}}
                      placeholder="Search collections"
                      autoComplete="off"
                      readOnly
                    />
                  }
                />
              ) : isCollectionReference ? (
                <Autocomplete
                  options={collectionOptions}
                  selected={bulkValue ? [bulkValue] : []}
                  onSelect={vals => setBulkValue(vals[0] || "")}
                  textField={
                    <Autocomplete.TextField
                      label="Select referenced collection"
                      value={bulkValue ? (collectionOptions.find(c => c.value === bulkValue)?.label || "") : ""}
                      onChange={() => {}}
                      placeholder="Search collections"
                      autoComplete="off"
                      readOnly
                    />
                  }
                />
              ) : isListType || (isJsonType && selectedOriginalType.startsWith("LIST.")) ? (
                <>
                  {bulkListValue.map((item, idx) => (
                    <div key={idx} style={{ display: "flex", alignItems: "center", marginBottom: ".5rem" }}>
                      <TextField
                        value={item}
                        onChange={val => {
                          const arr = [...bulkListValue]; arr[idx] = val; setBulkListValue(arr);
                        }}
                        multiline autoComplete="off" fullWidth
                        label={idx === 0 ? "Bulk List Item" : undefined}
                        labelHidden={idx !== 0}
                      />
                      {bulkListValue.length > 1 && (
                        <button type="button" onClick={() => { const arr = [...bulkListValue]; arr.splice(idx, 1); setBulkListValue(arr.length ? arr : [""]); }}
                          style={{ background: "#fde68a", color: "#765b14", border: "none", borderRadius: 4, cursor: "pointer", marginLeft: 8, fontWeight: "bold", fontSize: 18 }}>
                          −
                        </button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setBulkListValue([...bulkListValue, ""])}
                    style={{ background: "#f6b4cc", color: "#000", border: "none", padding: "6px 12px", borderRadius: 4, cursor: "pointer", marginTop: ".5rem" }}>
                    ＋ Add List Item
                  </button>
                </>
              ) : (
                <TextField
                  value={bulkValue}
                  onChange={setBulkValue}
                  label="Bulk Value"
                  autoComplete="off"
                  fullWidth
                  multiline={selectedType === "multi_line_text_field" || selectedType === "rich_text_field" || selectedType === "json"}
                />
              )}
              <Button onClick={handleBulkSet} style={{ marginTop: ".5rem" }}>Set All Values</Button>
            </div>
          )}

          {/* Table/List of Collections */}
          {selectedDef && selectedCollectionIds.length > 0 && (
            <div style={{ marginBottom: "1.5rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px" }}>Collection</th>
                    <th style={{ textAlign: "left", padding: "8px" }}>Metafield Value</th>
                    <th style={{ textAlign: "left", padding: "8px" }}>Update</th>
                    <th style={{ textAlign: "left", padding: "8px" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCollectionIds.map(cid => {
                    const collection = collectionOptions.find(c => c.value === cid);
                    let value = metafieldValues[cid] || "";
                    let listVal = listValues[cid] || [];
                    return (
                      <tr key={cid}>
                        <td style={{ padding: "8px" }}>{collection?.label}</td>
                        <td style={{ padding: "8px" }}>
                          {isListCollectionReference ? (
                            <Autocomplete
                              options={collectionOptions}
                              selected={Array.isArray(listVal) ? listVal : []}
                              onSelect={vals => handleListValueChange(cid, vals)}
                              allowMultiple
                              textField={
                                <Autocomplete.TextField
                                  label="Referenced collections"
                                  value={
                                    Array.isArray(listVal)
                                      ? listVal
                                        .map(id => collectionOptions.find(opt => opt.value === id)?.label)
                                        .filter(Boolean)
                                        .join(", ")
                                      : ""
                                  }
                                  onChange={() => {}}
                                  placeholder="Search collections"
                                  autoComplete="off"
                                  readOnly
                                />
                              }
                            />
                          ) : isCollectionReference ? (
                            <Autocomplete
                              options={collectionOptions}
                              selected={value ? [value] : []}
                              onSelect={vals => handleValueChange(cid, vals[0] || "")}
                              textField={
                                <Autocomplete.TextField
                                  label="Referenced collection"
                                  value={
                                    value
                                      ? (collectionOptions.find(c => c.value === value)?.label || "")
                                      : ""
                                  }
                                  onChange={() => {}}
                                  placeholder="Search collections"
                                  autoComplete="off"
                                  readOnly
                                />
                              }
                            />
                          ) : isListType || (isJsonType && selectedOriginalType.startsWith("LIST.")) ? (
                            <>
                              {listVal.map((item, idx) => (
                                <div key={idx} style={{ display: "flex", alignItems: "center", marginBottom: ".5rem" }}>
                                  <TextField
                                    value={item}
                                    onChange={val => handleListValueChange(cid, listVal.map((it, i) => i === idx ? val : it))}
                                    multiline autoComplete="off" fullWidth
                                    label={idx === 0 ? "Metafield Value (List Item)" : undefined}
                                    labelHidden={idx !== 0}
                                  />
                                  {listVal.length > 1 && (
                                    <button type="button" onClick={() => handleRemoveListItem(cid, idx)}
                                      style={{
                                        background: "#f37b7b", color: "white", border: "none", borderRadius: 4,
                                        cursor: "pointer", marginLeft: "8px", fontWeight: "bold", fontSize: 18
                                      }}>−</button>
                                  )}
                                </div>
                              ))}
                              <button type="button" onClick={() => handleAddListItem(cid)}
                                style={{ background: "#7fabf0", color: "white", border: "none", padding: "3px 9px", borderRadius: 4, cursor: "pointer", marginTop: ".5rem" }}>
                                ＋ Add List Item
                              </button>
                            </>
                          ) : (
                            <TextField
                              label="Metafield Value"
                              value={value}
                              onChange={val => handleValueChange(cid, val)}
                              multiline={selectedType === "multi_line_text_field" || selectedType === "rich_text_field" || selectedType === "json"}
                              autoComplete="off"
                              fullWidth
                            />
                          )}
                        </td>
                        <td style={{ padding: "8px" }}>
                          <Button onClick={e => { e.preventDefault(); handleRowUpdate(cid); }} size="slim">Update</Button>
                          <Button destructive size="slim" onClick={e => { e.preventDefault(); handleRowClear(cid); }} style={{ marginLeft: "6px" }}>
                            Clear Values
                          </Button>
                        </td>
                        <td style={{ padding: "8px" }}>
                          {successMap[cid] && (
                            <Text variant="bodyMd" color="success">✅</Text>
                          )}
                          {errorMap[cid] && (
                            <Text variant="bodyMd" color="critical">{errorMap[cid]}</Text>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* Save/Update Button */}
          <Button
            submit
            primary
            loading={fetcher.state === "submitting" || fetcher.state === "loading"}
            disabled={
              !selectedCollectionIds.length ||
              !selectedDef ||
              fetcher.state === "submitting" ||
              fetcher.state === "loading"
            }
            style={{
              backgroundColor: "#16a34a",
              color: "white",
              padding: "10px 20px",
              borderRadius: "6px",
            }}
          >
            Save All Metafields
          </Button>
        </form>
      </Card>
    </Layout.Section>
  </Layout>
</Page>
  );
}
