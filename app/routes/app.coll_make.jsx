import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  Page, Layout, Card, Autocomplete, TextField, Button, Text,
  FormLayout, Select, Icon, Toast, Frame
} from "@shopify/polaris";
import { useState, useCallback, useMemo, useEffect } from "react";
import { DeleteIcon } from "@shopify/polaris-icons"; // Assuming this icon is available

// === METAFIELD TYPE MAPS ===
// This map is primarily used for displaying metafield types in the bulk editor
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

  // --- Fetch all collections (from original code1) ---
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

  // --- Fetch metafield definitions for collections (from original code1) ---
  let collectionMetafieldDefinitions = [];
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
    collectionMetafieldDefinitions.push(...edges.map(e => ({
      ...e.node,
      type: typeMap[e.node.type.name] || e.node.type.name,
      originalType: e.node.type.name,
    })));
    hasNextPage = data?.data?.metafieldDefinitions?.pageInfo?.hasNextPage;
    if (hasNextPage) defCursor = edges[edges.length - 1].cursor;
  }

  // --- Fetch product metafield definitions (from original code2) ---
  let productMetafieldDefinitions = [];
  const productMetafieldsQuery = `
    {
      metafieldDefinitions(first: 100, ownerType: PRODUCT) {
        edges {
          node {
            id
            namespace
            key
            name
            type
          }
        }
      }
    }
  `;
  try {
    const resp = await admin.graphql(productMetafieldsQuery);
    const jsonResp = await resp.json();
    productMetafieldDefinitions = jsonResp.data.metafieldDefinitions.edges.map(e => e.node);
  } catch (err) {
    console.error("Error fetching product metafield definitions:", err);
    productMetafieldDefinitions = []; // Fallback to empty list on error
  }

  return json({ collections, collectionMetafieldDefinitions, productMetafieldDefinitions });
}

// === ACTION ===
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // --- CREATE SMART COLLECTION (from original code2, renamed intent) ---
  if (intent === "createSmartCollection") {
    const title = form.get("title");
    const matchType = form.get("match");
    const ruleCount = parseInt(form.get("ruleCount") || "0");

    const rules = [];

    for (let i = 0; i < ruleCount; i++) {
      const column = form.get(`column_${i}`);
      const relation = form.get(`relation_${i}`);
      const condition = form.get(`condition_${i}`);
      if (column === "METAFIELD") {
        const metafieldDef = form.get(`metafield_def_${i}`) || "";
        const [namespace, key] = metafieldDef.split("|||"); // Using ||| as separator from code2
        if (namespace && key && relation && condition != null) {
          rules.push({
            column,
            relation,
            condition,
            metafieldNamespace: namespace,
            metafieldKey: key,
          });
        }
      } else {
        if (column && relation && condition != null) {
          rules.push({ column, relation, condition });
        }
      }
    }

    const mutation = `
      mutation collectionCreate($input: CollectionInput!) {
        collectionCreate(input: $input) {
          collection {
            id
            title
            handle
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const shopifyRules = rules.map((rule) => {
      if (rule.column === "METAFIELD") {
        return {
          column: rule.column,
          relation: rule.relation,
          condition: rule.condition,
          metafield: {
            namespace: rule.metafieldNamespace,
            key: rule.metafieldKey,
          },
        };
      }
      return {
        column: rule.column,
        relation: rule.relation,
        condition: rule.condition,
      };
    });

    const variables = {
      input: {
        title,
        ruleSet: {
          appliedDisjunctively: matchType === "ANY",
          rules: shopifyRules,
        },
      },
    };

    try {
      const response = await admin.graphql(mutation, { variables });
      const result = await response.json();

      if (result?.data?.collectionCreate?.userErrors?.length > 0) {
        return json(
          { success: false, errors: result.data.collectionCreate.userErrors, intent: "createSmartCollection" },
          { status: 400 }
        );
      }

      const newCollection = result.data.collectionCreate.collection;
      return json({ success: true, collection: newCollection, intent: "createSmartCollection" });
    } catch (err) {
      console.error("GraphQL error during smart collection creation:", err);
      return json({ success: false, errors: [{ message: "Something went wrong during smart collection creation." }], intent: "createSmartCollection" }, { status: 500 });
    }
  }

  // --- BULK GET (from original code1) ---
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
        console.error(`Error fetching metafield for collection ${collectionId}:`, err);
        return { collectionId, value: null };
      }
    }));
    const values = {};
    for (const { collectionId, value } of results)
      values[collectionId] = value;
    return json({ success: true, values, originalType, intent });
  }

  // --- BULK SET (from original code1) ---
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
        console.error(`Error updating metafield for collection ${collectionId}:`, err);
        return { collectionId, success: false, errors: [{ message: "Server error" }] };
      }
    }));
    const allSuccess = results.every(r => r.success);
    return json({ success: allSuccess, results, intent });
  }

  // --- SINGLE ROW UPDATE (from original code1) ---
  if (intent === "updateMetafield") {
    const collectionId = form.get("collectionId");
    const definition = form.get("definition");
    const value = form.get("value"); // Value can be an empty string, which is valid for clearing
    if (!collectionId || !definition || value === null) { // Check for null, empty string is allowed
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
      console.error(`Error updating single metafield for collection ${collectionId}:`, err);
      return json({
        success: false,
        errors: [{ message: "Server error during metafield update." }],
        intent: "updateMetafield",
        collectionId,
      });
    }
  }

  // --- SINGLE CLEAR (from original code1) ---
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
    if (errs.length) {
      console.error(`Error clearing metafield for collection ${collectionId}:`, errs);
      return json({ success: false, errors: errs, intent, collectionId });
    }
    return json({ success: true, intent, collectionId });
  }

  return json({ success: false, errors: [{ message: "Invalid action intent." }] });
}

// === CLIENT/UI COMPONENT ===
export default function CollectionManagementPage() {
  const { collections, collectionMetafieldDefinitions, productMetafieldDefinitions } = useLoaderData();
  const bulkEditorFetcher = useFetcher(); // For bulk metafield operations
  const createCollectionFetcher = useFetcher(); // For creating smart collections
  const revalidator = useRevalidator(); // To revalidate loader data after creating a collection

  const [collectionSearch, setCollectionSearch] = useState("");
  const [selectedCollectionIds, setSelectedCollectionIds] = useState([]);
  const [selectedDef, setSelectedDef] = useState("");
  const [metafieldValues, setMetafieldValues] = useState({});
  const [listValues, setListValues] = useState({});
  const [bulkValue, setBulkValue] = useState("");
  const [bulkListValue, setBulkListValue] = useState([]);
  const [successMap, setSuccessMap] = useState({});
  const [errorMap, setErrorMap] = useState({});

  // State for showing/hiding the create collection form
  const [showCreateCollectionForm, setShowCreateCollectionForm] = useState(false);

  // State for create smart collection form
  const [newCollectionTitle, setNewCollectionTitle] = useState("");
  const [rules, setRules] = useState([
    { column: "TITLE", relation: "EQUALS", condition: "" },
  ]);
  const [matchType, setMatchType] = useState("ALL");

  // Toast state
  const [toastActive, setToastActive] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastError, setToastError] = useState(false);
  const toggleToastActive = useCallback(() => setToastActive((active) => !active), []);

  // --- Metafield Definition Options for Bulk Editor ---
  const definitionOptions = useMemo(() => [{
    label: "Select a metafield definition", value: "", disabled: true
  }].concat(collectionMetafieldDefinitions.map(def => ({
    label: `${def.name} (${def.namespace}.${def.key}) - ${def.type.replace(/_/g, ' ')}`,
    value: `${def.namespace}___${def.key}___${def.originalType}`,
    namespace: def.namespace,
    key: def.key,
    type: def.type,
    originalType: def.originalType,
  }))), [collectionMetafieldDefinitions]);
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

  // --- Collection Options for Bulk Editor Autocomplete ---
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

  // ------- FETCH VALUES for Bulk Editor -------
  useEffect(() => {
    if (selectedCollectionIds.length && selectedDef) {
      bulkEditorFetcher.submit(
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
  }, [selectedCollectionIds, selectedDef]); // Removed bulkEditorFetcher from dependency array to prevent infinite loop

  useEffect(() => {
    if (bulkEditorFetcher.data?.success && bulkEditorFetcher.data?.intent === "getMetafieldValuesBulk") {
      const fetched = bulkEditorFetcher.data.values || {};
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
  }, [bulkEditorFetcher.data, isListType, isJsonType, isListCollectionReference, selectedCollectionIds]);

  useEffect(() => {
    if (bulkEditorFetcher.data?.intent === "updateMetafieldsBulk" && bulkEditorFetcher.data?.results) {
      const s = {}, e = {};
      bulkEditorFetcher.data.results.forEach(r => {
        if (r.success) s[r.collectionId] = true;
        else e[r.collectionId] = r.errors?.map(x => x.message).join(", ") || "Error";
      });
      setSuccessMap(s);
      setErrorMap(e);
      if (bulkEditorFetcher.data.success) {
        setToastMessage("Bulk update successful!");
        setToastError(false);
      } else {
        setToastMessage("Bulk update failed for some collections.");
        setToastError(true);
      }
      setToastActive(true);
    }
    if (bulkEditorFetcher.data?.intent === "updateMetafield" && bulkEditorFetcher.data?.collectionId) {
      if (bulkEditorFetcher.data.success) {
        setSuccessMap((prev) => ({ ...prev, [bulkEditorFetcher.data.collectionId]: true }));
        setToastMessage("Metafield updated successfully!");
        setToastError(false);
      }
      else {
        setErrorMap((prev) => ({ ...prev, [bulkEditorFetcher.data.collectionId]: bulkEditorFetcher.data.errors?.map(x => x.message).join(", ") || "Error" }));
        setToastMessage("Metafield update failed.");
        setToastError(true);
      }
      setToastActive(true);
    }
    if (bulkEditorFetcher.data?.intent === "clearMetafield" && bulkEditorFetcher.data?.collectionId) {
      const cid = bulkEditorFetcher.data.collectionId;
      if (bulkEditorFetcher.data.success) {
        setMetafieldValues(prev => ({ ...prev, [cid]: "" }));
        setListValues(prev => ({ ...prev, [cid]: isListCollectionReference ? [] : [""] }));
        setSuccessMap(prev => ({ ...prev, [cid]: true }));
        setErrorMap(prev => ({ ...prev, [cid]: undefined }));
        setToastMessage("Metafield cleared successfully!");
        setToastError(false);
      } else {
        setErrorMap(prev => ({
          ...prev,
          [cid]: bulkEditorFetcher.data.errors?.map(e => e.message).join(", ") || "Error",
        }));
        setToastMessage("Metafield clear failed.");
        setToastError(true);
      }
      setToastActive(true);
    }
  }, [bulkEditorFetcher.data, isListCollectionReference]); // Removed bulkEditorFetcher from dependency array to prevent infinite loop

  // --- Handle Create Collection Fetcher Data ---
  useEffect(() => {
    if (createCollectionFetcher.data?.intent === "createSmartCollection") {
      if (createCollectionFetcher.data.success) {
        setToastMessage(`Collection "${createCollectionFetcher.data.collection.title}" created successfully!`);
        setToastError(false);
        setShowCreateCollectionForm(false); // Hide the form on success
        setNewCollectionTitle(""); // Clear form
        setRules([{ column: "TITLE", relation: "EQUALS", condition: "" }]); // Reset rules
        setMatchType("ALL"); // Reset match type
        revalidator.revalidate(); // Revalidate loader to get the new collection in the list
      } else {
        const errorMessage = createCollectionFetcher.data.errors?.map(e => e.message).join(", ") || "Failed to create collection.";
        setToastMessage(errorMessage);
        setToastError(true);
      }
      setToastActive(true);
    }
  }, [createCollectionFetcher.data]); // Added createCollectionFetcher to dependency array

  // ---------- Bulk Editor Handlers --------------
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

  // --------- Field changes for Bulk Editor ---------
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

  // --------- BULK SET (for Bulk Editor) -----------
  const handleBulkSet = () => {
    if (isListCollectionReference) {
      selectedCollectionIds.forEach(cid => setListValues((prev) => ({ ...prev, [cid]: bulkListValue })));
    } else if (isListType || (isJsonType && selectedOriginalType.startsWith("LIST."))) { // Check originalType for list JSON
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

  // --------- BULK SUBMIT (for Bulk Editor) ----------
  const handleBulkSubmit = (e) => {
    e.preventDefault();
    const updates = selectedCollectionIds.map(cid => {
      let value = "";
      if (isListCollectionReference) {
        value = JSON.stringify(listValues[cid] || []);
      } else if (isCollectionReference) {
        value = metafieldValues[cid] ?? "";
      } else if (isListType || (isJsonType && selectedOriginalType.startsWith("LIST."))) {
        const rawList = listValues[cid] || [""];
        const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
        value = JSON.stringify(cleanList.length > 0 ? cleanList : []);
      } else if (isJsonType) {
        value = metafieldValues[cid] ?? "";
        try { value = JSON.stringify(JSON.parse(value)); } catch {
          setToastMessage("Invalid JSON format for one or more values.");
          setToastError(true);
          setToastActive(true);
          return null; // Indicate an error, prevent submission
        }
      } else {
        value = metafieldValues[cid] ?? "";
      }
      return { collectionId: cid, value };
    }).filter(Boolean); // Filter out nulls if JSON parsing failed

    if (updates.length === 0 && selectedDef) {
      setToastMessage("No valid metafield values to save or JSON format is invalid.");
      setToastError(true);
      setToastActive(true);
      return;
    }
    bulkEditorFetcher.submit(
      {
        intent: "updateMetafieldsBulk",
        definition: selectedDef,
        updates: JSON.stringify(updates),
      },
      { method: "post", action: "." }
    );
  };

  // ---------- ROW SUBMIT (for Bulk Editor) -----------
  const handleRowUpdate = (collectionId) => {
    let value = metafieldValues[collectionId];
    if (isListCollectionReference) {
      value = JSON.stringify(listValues[collectionId] || []);
    } else if (isCollectionReference) {
      value = metafieldValues[collectionId] ?? "";
    } else if (isListType || (isJsonType && selectedOriginalType.startsWith("LIST."))) {
      const rawList = listValues[collectionId] || [""];
      const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
      value = JSON.stringify(cleanList.length > 0 ? cleanList : []);
    } else if (isJsonType && metafieldValues[collectionId]) {
      value = metafieldValues[collectionId];
      try { value = JSON.stringify(JSON.parse(value)); } catch (e) {
        setToastMessage("Invalid JSON format.");
        setToastError(true);
        setToastActive(true);
        return;
      }
    }

    // Check if value is empty for non-list/non-JSON types and prompt to clear
    if (!value && !(isListType || isJsonType || isCollectionReference || isListCollectionReference)) {
      if (window.confirm("Value is empty. Do you want to clear this metafield?")) { // Using window.confirm as per original code, but consider a Polaris Modal for better UX
        handleRowClear(collectionId);
      }
      return;
    }

    bulkEditorFetcher.submit(
      { intent: "updateMetafield", collectionId, definition: selectedDef, value },
      { method: "post", action: "." }
    );
  };
  const handleRowClear = (collectionId) => {
    bulkEditorFetcher.submit(
      { intent: "clearMetafield", collectionId, definition: selectedDef },
      { method: "post", action: "." }
    );
  };

  // --- Smart Collection Creation Handlers (from original code2) ---
  const handleAddRule = () => {
    setRules([...rules, { column: "TITLE", relation: "EQUALS", condition: "" }]);
  };

  const handleRemoveRule = (index) => {
    const updated = [...rules];
    updated.splice(index, 1);
    setRules(updated);
  };

  const updateRule = (index, field, value) => {
    const updated = [...rules];
    updated[index] = { ...updated[index], [field]: value };

    // If user switches to METAFIELD, reset its metafieldDef
    if (field === "column" && value === "METAFIELD") {
      updated[index].metafieldDef = "";
    }
    setRules(updated);
  };

  const columnOptions = [
    { label: "Product Title", value: "TITLE" },
    { label: "Product Type", value: "TYPE" },
    { label: "Product Category", value: "CATEGORY" },
    { label: "Product Vendor", value: "VENDOR" },
    { label: "Tag", value: "TAG" },
    { label: "Price", value: "PRICE" },
    { label: "Compare-at Price", value: "COMPARE_AT_PRICE" },
    { label: "Weight", value: "WEIGHT" },
    { label: "Inventory Stock", value: "INVENTORY_STOCK" },
    { label: "Variant Title", value: "VARIANT_TITLE" },
    { label: "Metafield", value: "METAFIELD" },
  ];

  const relationOptions = [
    { label: "Equals", value: "EQUALS" },
    { label: "Not Equals", value: "NOT_EQUALS" },
    { label: "Contains", value: "CONTAINS" },
    { label: "Starts With", value: "STARTS_WITH" },
    { label: "Ends With", value: "ENDS_WITH" },
    { label: "Greater Than", value: "GREATER_THAN" },
    { label: "Less Than", value: "LESS_THAN" },
  ];

  // For product metafields: build dropdown options from loader data
  const productMetafieldOptions = productMetafieldDefinitions.map((m) => ({
    label: `${m.name} (${m.namespace}.${m.key})`,
    value: `${m.namespace}|||${m.key}`,
  }));

  const toastMarkup = toastActive ? (
    <Toast content={toastMessage} error={toastError} onDismiss={toggleToastActive} duration={3000} />
  ) : null;

  // === UI ===
  return (
    <Frame>
      <Page title="Collection Management">
        <Layout>
          {/* Main Section: Bulk Editor */}
          <Layout.Section>
            <Card sectioned>
              <Text as="h2" variant="headingMd" alignment="center" style={{marginBottom: '1rem'}}>
                Collection Metafield Bulk Editor
              </Text>
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
                        label="Search Collections to Edit"
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
                  <Text as="p" variant="bodyMd" style={{marginBottom: 12, color: '#444', display:"block"}}>
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
                        <Button onClick={() => setBulkListValue([...bulkListValue, ""])}
                          style={{ background: "#f6b4cc", color: "#000", border: "none", padding: "6px 12px", borderRadius: 4, cursor: "pointer", marginTop: ".5rem" }}>
                          ＋ Add List Item
                        </Button>
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

                {/* Table/List of Collections for individual editing */}
                {selectedDef && selectedCollectionIds.length > 0 && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: "8px" }}>Collection</th>
                          <th style={{ textAlign: "left", padding: "8px" }}>Metafield Value</th>
                          <th style={{ textAlign: "left", padding: "8px" }}>Actions</th> {/* Changed from 'Update' to 'Actions' */}
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
                              <td style={{ padding: "8px", minWidth: '250px' }}>
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
                                    <Button onClick={() => handleAddListItem(cid)}
                                      style={{ background: "#7fabf0", color: "white", border: "none", padding: "3px 9px", borderRadius: 4, cursor: "pointer", marginTop: ".5rem" }}>
                                      ＋ Add List Item
                                    </Button>
                                  </>
                                ) : (
                                  <TextField
                                    value={value}
                                    onChange={(val) => handleValueChange(cid, val)}
                                    multiline={selectedType === "multi_line_text_field" || selectedType === "rich_text_field" || selectedType === "json"}
                                    autoComplete="off"
                                    fullWidth
                                  />
                                )}
                              </td>
                              <td style={{ padding: "8px" }}>
                                <Button onClick={() => handleRowUpdate(cid)} primary>Update</Button>
                                <Button onClick={() => handleRowClear(cid)} destructive style={{marginLeft: '8px'}}>Clear</Button>
                              </td>
                              <td style={{ padding: "8px" }}>
                                {bulkEditorFetcher.state === "submitting" && bulkEditorFetcher.formData?.get("collectionId") === cid && (
                                  <Text as="span" color="subdued">Updating...</Text>
                                )}
                                {successMap[cid] && <Text as="span" color="success">✅ Saved</Text>}
                                {errorMap[cid] && <Text as="span" color="critical">❌ {errorMap[cid]}</Text>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div style={{marginTop: '1.5rem'}}>
                      <Button submit primary loading={bulkEditorFetcher.state === "submitting"}>
                        Save All Changes
                      </Button>
                    </div>
                  </div>
                )}
              </form>
            </Card>
          </Layout.Section>

          {/* Create Collection Section */}
          <Layout.Section>
            <Card sectioned>
              {!showCreateCollectionForm ? (
                <div style={{ textAlign: "center", padding: "1rem" }}>
                  <Button onClick={() => setShowCreateCollectionForm(true)} primary>
                    Create New Smart Collection
                  </Button>
                </div>
              ) : (
                <>
                  <Text as="h2" variant="headingMd" alignment="center" style={{marginBottom: '1rem'}}>
                    Create New Smart Collection
                  </Text>
                  <createCollectionFetcher.Form method="post" onSubmit={(e) => {
                    // Manually add intent to formData
                    const formData = new FormData(e.currentTarget);
                    formData.append("intent", "createSmartCollection");
                    createCollectionFetcher.submit(formData, { method: "post", action: "." });
                    e.preventDefault(); // Prevent default browser submission
                  }}>
                    <FormLayout>
                      <TextField
                        label="Collection Title"
                        name="title"
                        required
                        autoComplete="off"
                        value={newCollectionTitle}
                        onChange={setNewCollectionTitle}
                      />

                      <Select
                        label="Match products if"
                        name="match"
                        options={[
                          { label: "All conditions are met", value: "ALL" },
                          { label: "Any condition is met", value: "ANY" },
                        ]}
                        value={matchType}
                        onChange={setMatchType}
                      />

                      {rules.map((rule, index) => (
                        <div
                          key={index}
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "flex-end",
                            flexWrap: "wrap",
                            marginBottom: "12px",
                          }}
                        >
                          <Select
                            label="Column"
                            options={columnOptions}
                            name={`column_${index}`}
                            value={rule.column}
                            onChange={(value) => updateRule(index, "column", value)}
                          />
                          {/* If Metafield, show selection dropdown */}
                          {rule.column === "METAFIELD" && (
                            <Select
                              label="Metafield"
                              options={productMetafieldOptions}
                              name={`metafield_def_${index}`}
                              value={rule.metafieldDef || ""}
                              onChange={(v) =>
                                updateRule(index, "metafieldDef", v)
                              }
                              placeholder="Select a metafield"
                            />
                          )}
                          <Select
                            label="Relation"
                            options={relationOptions}
                            name={`relation_${index}`}
                            value={rule.relation}
                            onChange={(value) =>
                              updateRule(index, "relation", value)
                            }
                          />
                          <TextField
                            label="Condition"
                            name={`condition_${index}`}
                            value={rule.condition}
                            onChange={(value) =>
                              updateRule(index, "condition", value)
                            }
                          />
                          {rules.length > 1 && (
                            <Button
                              icon={<Icon source={DeleteIcon} />}
                              onClick={() => handleRemoveRule(index)}
                              plain
                              accessibilityLabel="Remove rule"
                              type="button"
                            />
                          )}
                        </div>
                      ))}

                      <Button onClick={handleAddRule} type="button">
                        + Add Rule
                      </Button>

                      <input type="hidden" name="ruleCount" value={rules.length} />

                      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                        <Button submit primary loading={createCollectionFetcher.state === "submitting"}>
                          Create Collection
                        </Button>
                        <Button onClick={() => setShowCreateCollectionForm(false)} disabled={createCollectionFetcher.state === "submitting"}>
                          Cancel
                        </Button>
                      </div>
                    </FormLayout>
                  </createCollectionFetcher.Form>
                </>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
      {toastMarkup}
    </Frame>
  );
}
