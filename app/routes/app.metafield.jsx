import { json, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  Autocomplete,
  TextField,
  Button,
  Select,
  Text,
} from "@shopify/polaris";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";

// Type Map (remains unchanged)
const typeMap = {
  STRING: "single_line_text_field",
  MULTILINE_TEXT_FIELD: "multi_line_text_field",
  RICH_TEXT: "rich_text_field",
  INTEGER: "number_integer",
  FLOAT: "number_decimal",
  BOOLEAN: "boolean",
  JSON: "json",
  DATE: "date",
  DATETIME: "date_time",
  MONEY: "money",
  URL: "url",
  COLOR: "color",
  RATING: "rating",
  DIMENSION: "dimension",
  VOLUME: "volume",
  WEIGHT: "weight",
  PRODUCT_REFERENCE: "product_reference",
  VARIANT_REFERENCE: "variant_reference",
  COLLECTION_REFERENCE: "collection_reference",
  FILE_REFERENCE: "file_reference",
  PAGE_REFERENCE: "page_reference",
  CUSTOMER_REFERENCE: "customer_reference",
  COMPANY_REFERENCE: "company_reference",
  METAOBJECT_REFERENCE: "metaobject_reference",
  MIXED_REFERENCE: "mixed_reference",
  "LIST.STRING": "list.single_line_text_field",
  "LIST.INTEGER": "list.number_integer",
  "LIST.BOOLEAN": "list.boolean",
  "LIST.JSON": "list.json",
};

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  let products = [];
  let productCursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const res = await admin.graphql(`
      {
        products(first: 100${productCursor ? `, after: "${productCursor}"` : ""}) {
          edges {
            cursor
            node { id title }
          }
          pageInfo { hasNextPage }
        }
      }
    `);
    const data = await res.json();
    const edges = data?.data?.products?.edges || [];
    products.push(...edges.map((e) => e.node));
    hasNextPage = data?.data?.products?.pageInfo?.hasNextPage;
    if (hasNextPage) productCursor = edges[edges.length - 1].cursor;
  }

  let definitions = [];
  let defCursor = null;
  hasNextPage = true;

  while (hasNextPage) {
    const res = await admin.graphql(`
      {
        metafieldDefinitions(first: 100, ownerType: PRODUCT${defCursor ? `, after: "${defCursor}"` : ""}) {
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
    definitions.push(
      ...edges.map((e) => {
        let typeKey = e.node.type.name;
        if (typeKey.startsWith("LIST.")) typeKey = "LIST." + typeKey.split(".")[1];
        return {
          ...e.node,
          type: typeMap[typeKey] || e.node.type.name,
          originalType: e.node.type.name,
        };
      })
    );
    hasNextPage = data?.data?.metafieldDefinitions?.pageInfo?.hasNextPage;
    if (hasNextPage) defCursor = edges[edges.length - 1].cursor;
  }

  return json({ products, definitions });
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function action({ request }) {
  const contentType = request.headers.get("content-type");
  if (request.method === "POST" && contentType?.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 10_000_000 });
    const formData = await unstable_parseMultipartFormData(request, uploadHandler);
    const file = formData.get("file");
    if (!file || typeof file !== "object") {
      return json({ success: false, error: "No file uploaded" }, { status: 400 });
    }
    const { admin } = await authenticate.admin(request);

    // 1. Get staged upload target
    const stagedUploadRes = await admin.graphql(`
      mutation {
        stagedUploadsCreate(input: [{
          filename: "${file.name}",
          mimeType: "${file.type}",
          resource: FILE,
          httpMethod: POST
        }]) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `);
    const stagedUploadData = await stagedUploadRes.json();
    const target = stagedUploadData.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      console.error("Failed to get staged upload target:", stagedUploadData.data?.stagedUploadsCreate?.userErrors);
      return json({ success: false, error: "Failed to prepare file upload." }, { status: 500 });
    }

    // 2. Upload file to Shopify storage
    const formUpload = new FormData();
    for (const param of target.parameters) formUpload.append(param.name, param.value);
    formUpload.append("file", file);
    const uploadResponse = await fetch(target.url, { method: "POST", body: formUpload });
    if (!uploadResponse.ok) {
      console.error("Failed to upload to Shopify storage:", uploadResponse.statusText);
      return json({ success: false, error: "Failed to upload file to Shopify's storage." }, { status: 500 });
    }

    // 3. Register file in Shopify
    let createdFileId = null;
    try {
      const fileCreateRes = await admin.graphql(`
        mutation {
          fileCreate(files: [{
            originalSource: "${target.resourceUrl}",
            contentType: FILE,
            alt: "${file.name}"
          }]) {
            files { ... on GenericFile { id url } }
            userErrors { field message }
          }
        }
      `);
      const fileCreateData = await fileCreateRes.json();
      const createdFile = fileCreateData.data?.fileCreate?.files?.[0];
      const userErrors = fileCreateData.data?.fileCreate?.userErrors || [];

      if (userErrors.length > 0) {
        console.error("Errors during file creation:", userErrors);
        return json({ success: false, error: userErrors.map(e => e.message).join(", ") }, { status: 500 });
      }
      if (!createdFile || !createdFile.id) {
        console.error("File creation successful but no ID returned:", fileCreateData);
        return json({ success: false, error: "Shopify created the file, but its ID wasn't immediately available." }, { status: 500 });
      }
      createdFileId = createdFile.id;
    } catch (err) {
      console.error("Error creating file in Shopify:", err);
      return json({ success: false, error: "An unexpected error occurred during file registration with Shopify." }, { status: 500 });
    }

    // 4. Poll for the file URL with retries
    let fileUrl = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await delay(RETRY_DELAY_MS);
      const fetchFileRes = await admin.graphql(`
        query getFileUrl($id: ID!) {
          node(id: $id) {
            ... on GenericFile {
              url
            }
          }
        }
      `, { variables: { id: createdFileId } });

      const fetchFileData = await fetchFileRes.json();
      const fetchedFile = fetchFileData.data?.node;

      if (fetchedFile?.url && /^https?:\/\//.test(fetchedFile.url)) {
        fileUrl = fetchedFile.url;
        break;
      }
      console.log(`Retry ${i + 1}/${MAX_RETRIES}: File URL not ready for ID ${createdFileId}`);
    }

    if (!fileUrl) {
      console.error(`Failed to get final file URL after ${MAX_RETRIES} retries for ID: ${createdFileId}`);
      return json({
        success: false,
        error: "Shopify is still processing your file. Please try again later or manually update the metafield.",
        fileId: createdFileId,
      }, { status: 500 });
    }

    return json({ success: true, url: fileUrl, intent: "uploadFile" });
  }

  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  // BULK UPDATE
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

    const results = await Promise.all(updates.map(async ({ productId, value }) => {
      if (!productId) return { productId, success: false, errors: [{ message: "Missing productId" }] };
      try {
        const variables = {
          metafields: [
            {
              ownerId: productId,
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
          return { productId, success: false, errors: userErrors };
        }
        return { productId, success: true };
      } catch (err) {
        return { productId, success: false, errors: [{ message: "Server error" }] };
      }
    }));

    const allSuccess = results.every(r => r.success);
    return json({ success: allSuccess, results, intent });
  }

  // SINGLE PRODUCT UPDATE (for per-row update)
  if (intent === "updateMetafield") {
    const productId = form.get("productId");
    const definition = form.get("definition");
    const value = form.get("value");
    if (!productId || !definition || value === null) {
      return json({ success: false, errors: [{ message: "Product ID, definition, and value are required." }], intent: "updateMetafield" });
    }
    const [namespace, key, originalType] = definition.split("___");
    if (originalType === "URL" && !/^https?:\/\//.test(value)) {
      return json({
        success: false,
        errors: [{ message: "URL metafield value must start with http:// or https://." }],
        intent: "updateMetafield",
      });
    }
    const mutation = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key namespace value }
          userErrors { field message }
        }
      }
    `;
    const variables = {
      metafields: [
        {
          ownerId: productId,
          namespace,
          key,
          type: originalType,
          value: value,
        },
      ],
    };

    try {
      const response = await admin.graphql(mutation, { variables });
      const result = await response.json();
      const userErrors = result?.data?.metafieldsSet?.userErrors || [];
      if (userErrors.length > 0) {
        return json({ success: false, errors: userErrors, intent: "updateMetafield", productId });
      }
      return json({ success: true, intent: "updateMetafield", productId });
    } catch (err) {
      console.error("Metafield mutation error:", err);
      return json({
        success: false,
        errors: [{ message: "Server error during metafield update." }],
        intent: "updateMetafield",
        productId,
      });
    }
  }

  // BULK GET
  if (intent === "getMetafieldValuesBulk") {
    const definition = form.get("definition");
    const productIds = JSON.parse(form.get("productIds") || "[]");
    if (!definition || !Array.isArray(productIds) || productIds.length === 0) {
      return json({ success: false, errors: [{ message: "Definition and at least one product required." }], intent });
    }
    const [namespace, key, originalType] = definition.split("___");
    const results = await Promise.all(productIds.map(async (productId) => {
      try {
        const res = await admin.graphql(`
          query getMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
            node(id: $ownerId) {
              ... on Product {
                metafield(namespace: $namespace, key: $key) {
                  value
                }
              }
            }
          }
        `, {
          variables: {
            ownerId: productId,
            namespace,
            key,
          },
        });
        const data = await res.json();
        const value = data?.data?.node?.metafield?.value;
        return { productId, value };
      } catch (err) {
        return { productId, value: null };
      }
    }));
    const values = {};
    for (const { productId, value } of results) values[productId] = value;
    return json({ success: true, values, originalType, intent });
  }

  // SINGLE GET (for initial single product mode)
  if (intent === "getMetafieldValue") {
    const productId = form.get("productId");
    const definition = form.get("definition");

    if (!productId || !definition) {
      return json({ success: false, errors: [{ message: "Product ID and definition are required to fetch metafield." }], intent: "getMetafieldValue" });
    }

    const [namespace, key, originalType] = definition.split("___");

    try {
      const res = await admin.graphql(`
        query getMetafield($ownerId: ID!, $namespace: String!, $key: String!) {
          node(id: $ownerId) {
            ... on Product {
              metafield(namespace: $namespace, key: $key) {
                value
              }
            }
          }
        }
      `, {
        variables: {
          ownerId: productId,
          namespace,
          key,
        },
      });

      const data = await res.json();
      const metafieldValue = data?.data?.node?.metafield?.value;

      return json({ success: true, value: metafieldValue, originalType, intent: "getMetafieldValue" });
    } catch (err) {
      console.error("Metafield fetch error:", err);
      return json({
        success: false,
        errors: [{ message: "Server error during metafield fetch." }],
        intent: "getMetafieldValue",
      });
    }
  }

  // ─────────────────────────────────────────
// NEW ► CLEAR METAFIELD VALUE (scalar types)
// ─────────────────────────────────────────
if (intent === "clearMetafield") {
  const productId  = form.get("productId");
  const definition = form.get("definition"); // "namespace___key"
  if (!productId || !definition) {
    return json({
      success: false,
      errors: [{ message: "Product ID and definition required." }],
      intent
    }, { status: 400 });
  }

  const [namespace, key] = definition.split("___");

  // 🔄 Use ownerId + namespace + key instead of ID
  const delRes = await admin.graphql(`
    mutation ($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, {
    variables: {
      metafields: [{ ownerId: productId, namespace, key }]
    }
  });

  const delData = await delRes.json();
  const errs = delData?.data?.metafieldsDelete?.userErrors || [];

  if (errs.length) {
    return json({ success: false, errors: errs, intent, productId });
  }

  return json({ success: true, intent, productId });
}

  return json({ success: false, errors: [{ message: "Invalid action intent." }] });
}




export default function ProductMetafieldEditor() {
  const { products, definitions } = useLoaderData();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);

  // MULTI PRODUCT SELECTION
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [selectedDef, setSelectedDef] = useState("");
  const [metafieldValues, setMetafieldValues] = useState({});
  const [listValues, setListValues] = useState({});
  const [uploading, setUploading] = useState(false);
  const [bulkValue, setBulkValue] = useState("");
  const [bulkListValue, setBulkListValue] = useState([""]);
  const [successMap, setSuccessMap] = useState({});
  const [errorMap, setErrorMap] = useState({});
  const [uploadProductId, setUploadProductId] = useState(null);

  // AUTOCOMPLETE MULTI
  const productOptions = useMemo(
    () => products.map((product) => ({ label: product.title, value: product.id })),
    [products]
  );
  // Filter out already-selected products from options
  const filteredProductOptions = useMemo(() => {
    if (!productSearch) return productOptions.filter(opt => !selectedProductIds.includes(opt.value)).slice(0, 20);
    return productOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(productSearch.toLowerCase()) &&
        !selectedProductIds.includes(option.value)
    );
  }, [productSearch, productOptions, selectedProductIds]);

  // DEFINITION
  const definitionOptions = definitions.map((def) => ({
    label: `${def.name} (${def.namespace}.${def.key})`,
    value: `${def.namespace}___${def.key}___${def.originalType}`,
    type: def.type,
    originalType: def.originalType,
  }));
  const selectedDefObj = definitionOptions.find((d) => d.value === selectedDef);
  const selectedType = selectedDefObj?.type || "";
  const selectedOriginalType = selectedDefObj?.originalType || "";
  const isListType = selectedType.startsWith("list.");
  const isJsonType = selectedType === "json";

  // FETCH VALUES WHEN SELECTION CHANGES
  useEffect(() => {
    if (selectedProductIds.length && selectedDef) {
      fetcher.submit(
        {
          intent: "getMetafieldValuesBulk",
          productIds: JSON.stringify(selectedProductIds),
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
  }, [selectedProductIds, selectedDef]);

  // SET VALUES FROM FETCHER
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "getMetafieldValuesBulk") {
      const fetched = fetcher.data.values || {};
      const newValues = {};
      const newListValues = {};
      for (const pid of selectedProductIds) {
        const v = fetched[pid];
        if (isListType || (isJsonType && Array.isArray(v))) {
          try {
            const arr = JSON.parse(v);
            newListValues[pid] = Array.isArray(arr) && arr.length > 0 ? arr : [""];
            newValues[pid] = "";
          } catch {
            newListValues[pid] = [v];
            newValues[pid] = "";
          }
        } else {
          newValues[pid] = v || "";
          newListValues[pid] = [""];
        }
      }
      setMetafieldValues(newValues);
      setListValues(newListValues);
    }
  }, [fetcher.data, isListType, isJsonType, selectedProductIds]);

  // HANDLE PRODUCT MULTI SELECT
  const handleProductSelect = useCallback(
    (selected) => {
      setSelectedProductIds((prev) => Array.from(new Set([...prev, ...selected])));
      setProductSearch("");
    },
    []
  );
  const handleRemoveProduct = (pid) => {
    setSelectedProductIds((prev) => prev.filter((id) => id !== pid));
    setMetafieldValues((prev) => {
      const copy = { ...prev };
      delete copy[pid];
      return copy;
    });
    setListValues((prev) => {
      const copy = { ...prev };
      delete copy[pid];
      return copy;
    });
    setSuccessMap((prev) => {
      const copy = { ...prev };
      delete copy[pid];
      return copy;
    });
    setErrorMap((prev) => {
      const copy = { ...prev };
      delete copy[pid];
      return copy;
    });
  };

  // HANDLE VALUE CHANGE
  const handleValueChange = (productId, val) => {
    setMetafieldValues((prev) => ({ ...prev, [productId]: val }));
  };
  const handleListValueChange = (productId, idx, val) => {
    setListValues((prev) => {
      const arr = [...(prev[productId] || [""])];
      arr[idx] = val;
      return { ...prev, [productId]: arr };
    });
  };
  const handleAddListItem = (productId) => {
    setListValues((prev) => ({
      ...prev,
      [productId]: [...(prev[productId] || [""]), ""],
    }));
  };
  const handleRemoveListItem = (productId, idx) => {
    setListValues((prev) => {
      const arr = [...(prev[productId] || [""])];
      arr.splice(idx, 1);
      return { ...prev, [productId]: arr.length > 0 ? arr : [""] };
    });
  };

  // BULK SET (APPEND BULK VALUES TO EXISTING LISTS)
const handleBulkSet = () => {
  const bulkItems = bulkListValue.filter(v => v && v.trim() !== ""); // <-- Applied here too, for safety
  console.log("bulkItems:", bulkItems);
  console.log("isListType:", isListType);
  console.log("isJsonType:", isJsonType);
  console.log("selectedProductIds:", selectedProductIds);

  if (isListType || (isJsonType && Array.isArray(bulkItems))) {
    console.log("Inside list/json type block");
    const updatedListValues = {};

    selectedProductIds.forEach(pid => {
      // Ensure existing items are valid strings before processing
      const existing = (listValues[pid] || []).filter(item => typeof item === 'string' && item.trim() !== ''); // <-- Crucial change here
      console.log(`Processing PID: ${pid}, Existing (filtered):`, existing);

      // If existing has list items, append bulk items
      // Now, existing will only contain valid, non-empty strings.
      if (existing.length > 0) { // Simpler check now that existing is filtered
        console.log("Appending to existing list");
        updatedListValues[pid] = [...existing, ...bulkItems];
      } else {
        // No existing valid values → assign bulk values directly
        console.log("Assigning bulk items directly (no existing valid values)");
        updatedListValues[pid] = [...bulkItems];
      }
    });

    console.log("updatedListValues before setListValues:", updatedListValues);
    setListValues(updatedListValues);
  } else {
    console.log("Inside non-list/json type block");
    const newVals = {};
    selectedProductIds.forEach(pid => {
      newVals[pid] = bulkValue;
    });
    console.log("newVals before setMetafieldValues:", newVals);
    setMetafieldValues(newVals);
  }
};


  // FILE UPLOAD
  const handleFileChange = async (e, productId) => {
    const file = e.target.files[0];
    if (file) {
      setUploading(true);
      setUploadProductId(productId);
      handleValueChange(productId, "Uploading...");
      const formData = new FormData();
      formData.append("file", file);
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  };
  // Set uploaded file URL to correct product
  useEffect(() => {
    if (
      fetcher.data?.intent === "uploadFile" &&
      fetcher.data?.success &&
      uploadProductId
    ) {
      handleValueChange(uploadProductId, fetcher.data.url);
      setUploading(false);
      setUploadProductId(null);
    }
    if (fetcher.data?.intent === "uploadFile" && !fetcher.data?.success) {
      setUploading(false);
      setUploadProductId(null);
      alert(fetcher.data.error || "Failed to upload file.");
    }
    // eslint-disable-next-line
  }, [fetcher.data, uploadProductId]);

  // BULK SUBMIT
const handleBulkSubmit = (e) => {
  e.preventDefault();

  const updates = selectedProductIds.map(pid => {
    let value = "";

    if (isListType || isJsonType) {
      const rawList = listValues[pid] || [""];
      const cleanList = rawList.filter(v => v.trim() !== "");
      value = JSON.stringify(cleanList.length > 0 ? cleanList : [""]);
    } else if (isJsonType && typeof metafieldValues[pid] === "string") {
      value = metafieldValues[pid];
    } else {
      value = metafieldValues[pid] ?? bulkValue ?? "";
    }

    return { productId: pid, value };
  });

  fetcher.submit(
    {
      intent: "updateMetafieldsBulk",
      definition: selectedDef,
      updates: JSON.stringify(updates),
    },
    { method: "post", action: "." }
  );
};

  // PER-ROW SUBMIT
  const handleRowUpdate = (productId) => {
    let value = metafieldValues[productId];
    if (isListType || (isJsonType && Array.isArray(listValues[productId]) && listValues[productId].some(v => v.trim() !== ""))) {
      value = JSON.stringify(listValues[productId].filter(v => v.trim() !== ""));
    } else if (isJsonType && metafieldValues[productId]) {
      value = metafieldValues[productId];
    }
    fetcher.submit(
      {
        intent: "updateMetafield",
        productId,
        definition: selectedDef,
        value,
      },
      { method: "post", action: "." }
    );
  };

  const handleRowClear = (productId) => {
    fetcher.submit(
      {
        intent: "clearMetafield",
        productId,
        definition: selectedDef,      // "namespace___key"
      },
      { method: "post", action: "." }
    );
  };

  // Success/error feedback per row
  useEffect(() => {
    if (fetcher.data?.intent === "updateMetafieldsBulk" && fetcher.data?.results) {
      const s = {}, e = {};
      fetcher.data.results.forEach(r => {
        if (r.success) s[r.productId] = true;
        else e[r.productId] = r.errors?.map(x => x.message).join(", ") || "Error";
      });
      setSuccessMap(s);
      setErrorMap(e);
    }
    if (fetcher.data?.intent === "updateMetafield" && fetcher.data?.productId) {
      if (fetcher.data.success) setSuccessMap((prev) => ({ ...prev, [fetcher.data.productId]: true }));
      else setErrorMap((prev) => ({ ...prev, [fetcher.data.productId]: fetcher.data.errors?.map(x => x.message).join(", ") || "Error" }));
    }

        if (fetcher.data?.intent === "clearMetafield" && fetcher.data?.productId) {
      const pid = fetcher.data.productId;
      if (fetcher.data.success) {
        setMetafieldValues(prev => ({ ...prev, [pid]: "" }));
        setListValues(prev => ({ ...prev, [pid]: [""] }));
        setSuccessMap(prev => ({ ...prev, [pid]: true }));
        setErrorMap(prev => ({ ...prev, [pid]: undefined }));
      } else {
        setErrorMap(prev => ({
          ...prev,
          [pid]: fetcher.data.errors?.map(e => e.message).join(", ") || "Error",
        }));
      }
    }
  }, [fetcher.data]);

  // UI
  return (
    <Page title="🚧 Metafield Workbench">
      <Layout>
        <Layout.Section>
          <Card sectioned spacing="loose">
            <form onSubmit={handleBulkSubmit}>
              {/* Selected Products as Chips */}
              {selectedProductIds.length > 0 && (
                <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {selectedProductIds.map(pid => {
                    const product = productOptions.find(p => p.value === pid);
                    return (
                      <span
                        key={pid}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          background: "linear-gradient(90deg, #fbbf24 0%, #f59e42 100%)",
                          color: "#1e293b",
                          fontWeight: 600,
                          borderRadius: "18px",
                          padding: "6px 14px 6px 12px",
                          fontSize: "14px",
                          boxShadow: "0 2px 6px #fbbf2430",
                          border: "1px solid #f59e42",
                          marginRight: "4px",
                        }}
                      >
                        {product?.label}
                        <button
                          type="button"
                          onClick={() => handleRemoveProduct(pid)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#d97706",
                            fontWeight: "bold",
                            fontSize: "15px",
                            marginLeft: "8px",
                            cursor: "pointer",
                            lineHeight: 1,
                          }}
                          title="Remove"
                          aria-label="Remove"
                        >×</button>
                      </span>
                    );
                  })}
                </div>
              )}
              {/* Product Multi-Select */}
              <div style={{ marginBottom: "1.5rem" }}>
                <Autocomplete
                  options={filteredProductOptions}
                  selected={[]}
                  onSelect={handleProductSelect}
                  allowMultiple
                  textField={
                    <Autocomplete.TextField
                      label="Search Products"
                      value={productSearch}
                      onChange={setProductSearch}
                      placeholder="Start typing a product name"
                      autoComplete="off"
                    />
                  }
                />
              </div>
              {/* Definition Dropdown */}
              <div style={{ marginBottom: "1.5rem" }}>
                <Select
                  label="Metafield Definition"
                  options={definitionOptions}
                  onChange={(value) => {
                    setSelectedDef(value);
                    setMetafieldValues({});
                    setListValues({});
                    setSuccessMap({});
                    setErrorMap({});
                  }}
                  value={selectedDef}
                  placeholder="Select a metafield definition"
                />
              </div>
              {/* Bulk Set */}
              {selectedProductIds.length > 1 && selectedDef && (
                <div style={{ marginBottom: "1.5rem" }}>
                  <Text as="p" variant="bodyMd" style={{ fontWeight: 700, color: "#f59e42", marginBottom: 8 }}>
                    Bulk set value for all selected products:
                  </Text>
                  {isListType || (isJsonType && Array.isArray(bulkListValue)) ? (
                    <>
                      {bulkListValue.map((item, idx) => (
                        <div key={idx} style={{
                          display: "flex",
                          alignItems: "center",
                          marginBottom: "0.5rem",
                          background: "#fffbe8",
                          border: "1.5px solid #fde68a",
                          borderRadius: "6px",
                          padding: "0.5rem",
                          boxShadow: "0 1px 8px #fde68a40"
                        }}>
                          <TextField
                            value={item}
                            onChange={val => {
                              const arr = [...bulkListValue];
                              arr[idx] = val;
                              setBulkListValue(arr);
                            }}
                            multiline
                            autoComplete="off"
                            fullWidth
                            label={idx === 0 ? <span style={{ color: "#f59e42", fontWeight: 700 }}>Bulk List Item</span> : undefined}
                            labelHidden={idx !== 0}
                            style={{
                              fontWeight: 700,
                              color: "#f59e42",
                              background: "transparent",
                              border: "none",
                              outline: "none"
                            }}
                          />
                          {bulkListValue.length > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                const arr = [...bulkListValue];
                                arr.splice(idx, 1);
                                setBulkListValue(arr.length ? arr : [""]);
                              }}
                              style={{
                                backgroundColor: "#fde68a",
                                color: "#fff",
                                border: "none",
                                width: "32px",
                                height: "32px",
                                borderRadius: "4px",
                                cursor: "pointer",
                                marginLeft: "8px",
                                fontWeight: "bold",
                                fontSize: "18px",
                              }}
                            >−</button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setBulkListValue([...bulkListValue, ""])}
                        style={{
                          background: "linear-gradient(90deg, #fde68a 0%, #fbbf24 100%)",
                          color: "#eb9553ff",
                          border: "none",
                          padding: "6px 12px",
                          borderRadius: "4px",
                          cursor: "pointer",
                          marginTop: "0.5rem",
                          fontWeight: 700,
                          fontSize: "15px",
                          boxShadow: "0 2px 6px #fde68a50"
                        }}
                      >＋ Add List Item</button>
                    </>
                  ) : (
                    <TextField
                      value={bulkValue}
                      onChange={setBulkValue}
                      label={<span style={{ color: "#f59e42", fontWeight: 700 }}>Bulk Value</span>}
                      autoComplete="off"
                      fullWidth
                      style={{
                        fontWeight: 700,
                        color: "#f59e42",
                        background: "#fffbe8",
                        border: "1.5px solid #fde68a",
                        borderRadius: "6px",
                        boxShadow: "0 1px 8px #fde68a40"
                      }}
                    />
                  )}
                  <Button onClick={handleBulkSet} style={{
                    marginTop: "0.5rem",
                    background: "linear-gradient(90deg, #fde68a 0%, #fbbf24 100%)",
                    color: "#b45309",
                    fontWeight: 700,
                    fontSize: "15px",
                    border: "none",
                    borderRadius: "6px",
                    boxShadow: "0 2px 6px #fde68a50"
                  }}>
                    Set All Values
                  </Button>
                </div>
              )}
              {/* Table/List of Products */}
              {selectedDef && selectedProductIds.length > 0 && (
                <div style={{ marginBottom: "1.5rem" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px" }}>Product</th>
                        <th style={{ textAlign: "left", padding: "8px" }}>Metafield Value</th>
                        <th style={{ textAlign: "left", padding: "8px" }}>Update</th>
                        <th style={{ textAlign: "left", padding: "8px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedProductIds.map(pid => {
                        const product = productOptions.find(p => p.value === pid);
                        let value = metafieldValues[pid] || "";
                        let listVal = listValues[pid] || [""];
                        return (
                          <tr key={pid} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "8px", verticalAlign: "top" }}>
                              <Text as="span" variant="bodyMd">{product?.label}</Text>
                            </td>
                            <td style={{ padding: "8px", verticalAlign: "top" }}>
                              {isListType || (isJsonType && Array.isArray(listVal)) ? (
                                <>
                                  {listVal.map((item, idx) => (
                                    <div key={idx} style={{ display: "flex", alignItems: "center", marginBottom: "0.5rem" }}>
                                      <TextField
                                        value={item}
                                        onChange={val => handleListValueChange(pid, idx, val)}
                                        multiline
                                        autoComplete="off"
                                        fullWidth
                                        label={idx === 0 ? "Metafield Value (List Item)" : undefined}
                                        labelHidden={idx !== 0}
                                      />
                                      {listVal.length > 1 && (
                                        <button
                                          type="button"
                                          onClick={() => handleRemoveListItem(pid, idx)}
                                          style={{
                                            backgroundColor: "#ef4444",
                                            color: "white",
                                            border: "none",
                                            width: "32px",
                                            height: "32px",
                                            borderRadius: "4px",
                                            cursor: "pointer",
                                            marginLeft: "8px",
                                          }}
                                        >−</button>
                                      )}
                                    </div>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => handleAddListItem(pid)}
                                    style={{
                                      backgroundColor: "#3b82f6",
                                      color: "white",
                                      border: "none",
                                      padding: "6px 12px",
                                      borderRadius: "4px",
                                      cursor: "pointer",
                                      marginTop: "0.5rem",
                                    }}
                                  >＋ Add List Item</button>
                                </>
                              ) : selectedType === "color" ? (
                                <label>
                                  <Text as="p" variant="bodyMd">Metafield Value</Text>
                                  <input
                                    type="color"
                                    value={value}
                                    onChange={e => handleValueChange(pid, e.target.value)}
                                    style={{ width: "100px", height: "40px", border: "1px solid #c4c4c4", borderRadius: "4px" }}
                                  />
                                </label>
                              ) : selectedType === "url" ? (
                                <>
                                  <Text as="p" variant="bodyMd">Upload PDF (or enter a URL)</Text>
                                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                                    <Button
                                      onClick={() => {
                                        setUploadProductId(pid);
                                        fileInputRef.current?.click();
                                      }}
                                      disabled={uploading}
                                    >Upload PDF</Button>
                                    <input
                                      type="file"
                                      accept="application/pdf"
                                      style={{ display: "none" }}
                                      ref={fileInputRef}
                                      onChange={e => handleFileChange(e, pid)}
                                    />
                                    {uploading && uploadProductId === pid && (
                                      <Text as="span" variant="bodySm" color="subdued">
                                        Uploading...
                                      </Text>
                                    )}
                                  </div>
                                  <TextField
                                    label="Metafield Value (URL)"
                                    value={value}
                                    onChange={val => handleValueChange(pid, val)}
                                    autoComplete="off"
                                    fullWidth
                                    placeholder="Paste a URL or upload a PDF"
                                  />
                                </>
                              ) : (
                                <TextField
                                  label="Metafield Value"
                                  value={value}
                                  onChange={val => handleValueChange(pid, val)}
                                  multiline
                                  autoComplete="off"
                                  fullWidth
                                />
                              )}
                            </td>
                            <td style={{ padding: "8px", verticalAlign: "top", }}>
                              <Button
                                onClick={e => { e.preventDefault(); handleRowUpdate(pid); }}
                                size="slim"
                                disabled={uploading}
                              >Update</Button>
                              <Button  /* ← paste here */
                                destructive
                                size="slim"
                                onClick={e => { e.preventDefault(); handleRowClear(pid); }}
                                disabled={uploading}
                                style={{ marginLeft: "6px" }}
>
                                Clear Values
                              </Button>

                            </td>
                            <td style={{ padding: "8px", verticalAlign: "top" }}>
                              {successMap[pid] && (
                                <Text variant="bodyMd" color="success">✅</Text>
                              )}
                              {errorMap[pid] && (
                                <Text variant="bodyMd" color="critical">{errorMap[pid]}</Text>
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
                  !selectedProductIds.length ||
                  !selectedDef ||
                  uploading ||
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
