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
  Modal,
  Form,
  FormLayout,
} from "@shopify/polaris";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  useActionData,
  useNavigation,
  Form as RemixForm,
} from "@remix-run/react";
// Type Map (remains unchanged)
const typeMap = {
  Single_line_text_field: "single_line_text_field",
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
  mixed_reference: "mixed_reference",
  "list.single_line_text_field": "list.single_line_text_field",
  "list.number_integer": "list.number_integer",
  "list.boolean": "list.boolean",
  "list.json": "list.json",
  "list.collection_reference": "list.collection_reference",
};

// Reverse Type Map for displaying original types
const reverseTypeMap = Object.fromEntries(
  Object.entries(typeMap).map(([key, value]) => [value, key])
);

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
          type: typeMap[typeKey] || e.node.type.name, // Display friendly type
          originalType: e.node.type.name, // Actual Shopify API type
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
    let admin;
try {
  const authResult = await authenticate.admin(request);

  if (!authResult || !authResult.admin) {
    console.error("Authentication failed: No admin session returned.");
    return new Response("Unauthorized", { status: 401 });
  }

  admin = authResult.admin;
} catch (err) {
  console.error("Authentication error during file upload/action:", err);
  return new Response("Unauthorized - error in authenticate.admin", { status: 401 });
}


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

if (intent === "createMetafieldDefinition") {
  const namespace = form.get("namespace");
  const key = form.get("key");
  const name = form.get("name");
  const friendlyType = form.get("type"); // Should be exact Shopify metafield type like "single_line_text_field"
  const description = form.get("description");

  if (!namespace || !key || !name || !friendlyType) {
    return json({
      success: false,
      errors: [{ message: "Namespace, Key, Name, and Type are required." }],
      intent,
    });
  }
  const shopifyType = typeMap[friendlyType];

    if (!shopifyType) {
      return json({
        success: false,
        errors: [
          { message: `Invalid metafield type: ${friendlyType}` },
        ],
      });
    }

  try {
    const mutation = `
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            key
            namespace
            name
            type { name }
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `;

    const variables = {
      definition: {
        key,
        namespace,
        name,
        ownerType: "PRODUCT",
        type: shopifyType,
        description: description || null,
      },
    };

    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    const userErrors = result?.data?.metafieldDefinitionCreate?.userErrors || [];
    const createdDef = result?.data?.metafieldDefinitionCreate?.definition;

    if (userErrors.length > 0) {
      return json({ success: false, errors: userErrors, intent });
    }

    return json({ success: true, definition: createdDef, intent });

  } catch (err) {
    console.error("Metafield definition creation error:", err);
    return json({
      success: false,
      errors: [{ message: "Unexpected server error." }],
      intent,
    });
  }
}


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
          query getMetafield($ownerId: ID!, $namespace:  Single_line_text_field!, $key:  Single_line_text_field!) {
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
        query getMetafield($ownerId: ID!, $namespace:  Single_line_text_field!, $key:  Single_line_text_field!) {
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
  // CLEAR METAFIELD VALUE (scalar types)
  // ─────────────────────────────────────────
  if (intent === "clearMetafield") {
    const productId = form.get("productId");
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

// NEW: CreateMetafieldDefinitionModal component
function CreateMetafieldDefinitionModal({ isOpen, onClose, onSubmit, isSubmitting, errors }) {
  const actionData = useActionData();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const [namespace, setNamespace] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("single_line_text_field");

  const metafieldOptions = Object.entries(typeMap).map(([label, _value]) => ({
    label: label.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
    value: label,
  }));



  const handleSubmit = useCallback(() => {
    onSubmit({ namespace, key, name, type: type, description }); // Pass the original API type
  }, [namespace, key, name, type, description, onSubmit]);

  useEffect(() => {
    if (!isOpen) {
      setNamespace("");
      setKey("");
      setName("");
      setType("single_line_text_field");
      setDescription("");
    }
  }, [isOpen]);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Create New Metafield Definition"
      primaryAction={{
        content: "Create",
        onAction: handleSubmit,
        loading: isSubmitting,
        disabled: isSubmitting || !namespace || !key || !name || !type,
      }}
      secondaryActions={[
        {
          content: "Cancel",
          onAction: onClose,
          disabled: isSubmitting,
        },
      ]}
    >
      <Modal.Section>
        <Form onSubmit={handleSubmit}>
          <FormLayout>
            {errors && errors.length > 0 && (
              <Text color="critical" as="p">
                {errors.map((error, idx) => (
                  <span key={idx}>{error.message}</span>
                ))}
              </Text>
            )}
            <TextField
              label="Namespace"
              value={namespace}
              onChange={setNamespace}
              helpText="e.g., 'my_app' or 'custom'"
              autoComplete="off"
              requiredIndicator
            />
            <TextField
              label="Key"
              value={key}
              onChange={setKey}
              helpText="e.g., 'product_info' or 'product_pdf'"
              autoComplete="off"
              requiredIndicator
            />
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              helpText="Display name for the metafield (e.g., 'Product Information')"
              autoComplete="off"
              requiredIndicator
            />
            <Select
              label="Type"
              options={metafieldOptions}
              onChange={setType}
              value={type}
              helpText="Choose the data type for your metafield."
              requiredIndicator
            />
            <TextField
              label="Description (Optional)"
              value={description}
              onChange={setDescription}
              multiline
              autoComplete="off"
            />
            {actionData?.success && (
            <Card sectioned>
              <Text variant="headingMd">
                ✅ Metafield created successfully!
              </Text>
            </Card>
          )}
          </FormLayout>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

// Converts 2D array of [specification, value] rows into HTML table string
function generateTableHTML(tableData) {
  let html = "<table>";
  html += "<thead><tr><th>Specification</th><th>Value</th></tr></thead><tbody>";
  for (const row of tableData) {
    html += `<tr><td>${row[0] || ""}</td><td>${row[1] || ""}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

// TableBuilder UI component
function TableBuilder({ data, onChange }) {
  const addRow = () => onChange([...data, ["", ""]]);
  const removeRow = (idx) => {
    if (data.length <= 1) return;
    onChange(data.filter((_, i) => i !== idx));
  };
  const updateCell = (rowIdx, colIdx, val) => {
    const updated = data.map((row, i) =>
      i === rowIdx ? row.map((cell, j) => (j === colIdx ? val : cell)) : row
    );
    onChange(updated);
  };

  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ border: "1px solid #ccc", padding: 6 }}>Specification</th>
            <th style={{ border: "1px solid #ccc", padding: 6 }}>Value</th>
            <th></th> {/* For remove button */}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr key={idx}>
              {[0, 1].map((colIdx) => (
                <td key={colIdx} style={{ border: "1px solid #ccc", padding: 6, minWidth: 100 }}>
                  <input
                    type="text"
                    value={row[colIdx]}
                    onChange={(e) => updateCell(idx, colIdx, e.target.value)}
                    style={{ width: "100%", border: "none", outline: "none" }}
                  />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={data.length <= 1}
                  style={{ cursor: data.length <= 1 ? "not-allowed" : "pointer" }}
                  title="Remove Row"
                >
                  −
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} style={{ textAlign: "left", paddingTop: 6 }}>
              <button type="button" onClick={addRow}>＋ Add Row</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}






export default function ProductMetafieldEditor() {
  const { products, definitions } = useLoaderData();
  const fetcher = useFetcher();
  const definitionFetcher = useFetcher(); // New fetcher for definition creation
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

  // NEW: Metafield Definition Creation State
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Add inside ProductMetafieldEditor component, near your other useState calls
  const [multiTextModeByProduct, setMultiTextModeByProduct] = useState({});
  const [tableDataByProduct, setTableDataByProduct] = useState({});

  // Bulk input mode for multiline text metafields: "plain" or "html" (table)
  const [bulkMultiTextMode, setBulkMultiTextMode] = useState("plain");

// Bulk table data for HTML mode: array of rows, each row is [specification, value]
  const [bulkTableData, setBulkTableData] = useState([["", ""]]);


  

  // AUTOCOMPLETE MULTI for Products
  const productOptions = useMemo(
    () => products.map((product) => ({ label: product.title, value: product.id })),
    [products]
  );
  // Filter out already-selected products from options + add "Select All"
  const filteredProductOptions = useMemo(() => {
    let options = productOptions.filter(opt => !selectedProductIds.includes(opt.value));

    // Add "Select All Products" option
    const selectAllOption = { label: "Select All Products", value: "ALL" };
    if (productSearch.toLowerCase() === "all" || productSearch === "") {
      options = [selectAllOption, ...options];
    } else {
      options = options.filter(
        (option) => option.label.toLowerCase().includes(productSearch.toLowerCase())
      );
    }
    return options.slice(0, 20); // Limit to top 20 suggestions
  }, [productSearch, productOptions, selectedProductIds]);

  // DEFINITION options (now using Polaris Select)
 // 🔹 1. Memoize the raw definition options
const definitionOptions = useMemo(() => {
  const opts = definitions.map((def) => ({
    label: `${def.name} (${def.namespace}.${def.key}) - ${def.type.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())}`,
    value: `${def.namespace}___${def.key}___${def.originalType}`,
    type: def.type,
    originalType: def.originalType,
  }));
  return [{ label: "Select a metafield definition", value: "", disabled: true }, ...opts];
}, [definitions]);


// 🔹 2. Create search state and filtered options outside of useMemo
const [defSearch, setDefSearch] = useState("");

const filteredDefs = useMemo(() => {
  return definitionOptions.filter(def =>
    def.label.toLowerCase().includes(defSearch.toLowerCase())
  );
}, [definitionOptions, defSearch]);


// 🔹 3. Extract selected definition type
const selectedDefObj = definitionOptions.find((d) => d.value === selectedDef);
const selectedType = selectedDefObj?.type || "";
const selectedOriginalType = selectedDefObj?.originalType || "";
const isListType = selectedType.startsWith("list.");
const isJsonType = selectedType === "json";
const isFileType = selectedType === "file_reference";



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
      if (selected.includes("ALL")) {
        setSelectedProductIds(productOptions.map(p => p.value)); // Select all available products
      } else {
        setSelectedProductIds((prev) => Array.from(new Set([...prev, ...selected])));
      }
      setProductSearch("");
    },
    [productOptions]
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

 const handleBulkSet = () => {
  // =========================
  // 1. Multi-line Text Field: HTML TABLE MODE
  // =========================
  if (selectedType === "multi_line_text_field" && bulkMultiTextMode === "html") {
    const newTableDataByProduct = { ...tableDataByProduct };
    const newMultiTextModeByProduct = { ...multiTextModeByProduct };
    selectedProductIds.forEach(pid => {
      newTableDataByProduct[pid] = bulkTableData;
      newMultiTextModeByProduct[pid] = "html";
    });
    setTableDataByProduct(newTableDataByProduct);
    setMultiTextModeByProduct(newMultiTextModeByProduct);
    console.log("Bulk set HTML table data and mode:", newTableDataByProduct, newMultiTextModeByProduct);
    return;
  }

  // =========================
  // 2. Multi-line Text Field: PLAIN TEXT MODE (this was missing/needed)
  // =========================
  if (selectedType === "multi_line_text_field" && bulkMultiTextMode === "plain") {
    const newVals = { ...metafieldValues };
    const newMultiTextModeByProduct = { ...multiTextModeByProduct };
    selectedProductIds.forEach(pid => {
      newVals[pid] = bulkValue;
      newMultiTextModeByProduct[pid] = "plain";
    });
    setMetafieldValues(newVals);
    setMultiTextModeByProduct(newMultiTextModeByProduct);
    console.log("Bulk set plain text and mode:", newVals, newMultiTextModeByProduct);
    return;
  }

  // =========================
  // 3. LIST/JSON TYPES
  // =========================
  const bulkItems = bulkListValue.filter(v => v && v.trim() !== "");
  if (isListType || (isJsonType && Array.isArray(bulkItems))) {
    console.log("Inside list/json type block");
    const updatedListValues = {};
    selectedProductIds.forEach(pid => {
      // Ensure existing items are valid strings before processing
      const existing = (listValues[pid] || []).filter(item => typeof item === 'string' && item.trim() !== '');
      console.log(`Processing PID: ${pid}, Existing (filtered):`, existing);
      if (existing.length > 0) {
        updatedListValues[pid] = [...existing, ...bulkItems];
      } else {
        updatedListValues[pid] = [...bulkItems];
      }
    });
    console.log("updatedListValues before setListValues:", updatedListValues);
    setListValues(updatedListValues);
    return;
  }

  // =========================
  // 4. SCALAR (DEFAULT) TYPES
  // =========================
  console.log("Inside non-list/json type block");
  const newVals = {};
  selectedProductIds.forEach(pid => {
    newVals[pid] = bulkValue;
  });
  console.log("newVals before setMetafieldValues:", newVals);
  setMetafieldValues(newVals);
};

  // FILE UPLOAD
  const handleFileChange = async (e, productId) => {
    const file = e.target.files[0];
    if (file) {
      setUploading(true);
      setUploadProductId(productId);
      handleValueChange(productId, "Uploading..."); // Show uploading status in the text field
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

  const handleBulkSubmit = (e) => {
  e.preventDefault();

  // Prepare update payload for each selected product
  const updates = selectedProductIds.map(pid => {
    let value = "";

    // Handle multi_line_text_field in "html" mode (table input)
    if (selectedType === "multi_line_text_field" && multiTextModeByProduct[pid] === "html") {
  value = generateTableHTML(tableDataByProduct[pid] || [["", ""]]);
}
    // Handle Shopify LIST types or JSON lists
    else if (
      isListType ||
      (isJsonType && Array.isArray(listValues[pid]) && selectedOriginalType.startsWith("LIST."))
    ) {
      const rawList = listValues[pid] || [""];
      const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
      // Send stringified JSON array, empty array if no valid items
      value = JSON.stringify(cleanList.length > 0 ? cleanList : []);
    }
    // Handle general JSON types (non-list JSON)
    else if (isJsonType) {
      value = metafieldValues[pid] ?? bulkValue ?? "";
      try {
        // Validate that value is valid JSON; if not, reset to empty string
        value = JSON.stringify(JSON.parse(value));
      } catch (err) {
        console.warn("Invalid JSON for product", pid, ":", value);
        value = "";
      }
    }
    // Handle scalar types (string, integer, color, boolean, etc.)
    else {
      value = metafieldValues[pid] ?? bulkValue ?? "";
    }

    return { productId: pid, value };
  });

  // Filter to allow all list/JSON updates, but ignore empty scalar values
  const filteredUpdates = updates.filter(({ value }) => {
    if (isListType || (isJsonType && selectedOriginalType.startsWith("LIST."))) {
      return true; // accept all JSON lists (even empty arrays)
    }
    if (isJsonType) {
      return true; // accept all JSON, backend handles validation
    }
    // For scalar types, ignore empty or null values
    return value !== "" && value !== null && value !== undefined;
  });

  if (filteredUpdates.length === 0 && selectedDef) {
    alert("No valid metafield values to save for the selected definition and products. All values are empty or invalid.");
    return;
  }

  // Submit updates (you can switch to filteredUpdates here if you want to only submit valid entries)
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
  let value = "";

  // Handle multiline_text_field with "html" input mode (Table Builder)
  if (selectedType === "multi_line_text_field" && multiTextModeByProduct[productId] === "html") {
    const tableData = tableDataByProduct[productId] || [["", ""]];
    value = generateTableHTML(tableData); // Convert table data to HTML string
  } else if (isListType || (isJsonType && Array.isArray(listValues[productId]) && selectedOriginalType.startsWith("LIST."))) {
    const rawList = listValues[productId] || [""];
    const cleanList = rawList.filter(v => v !== null && v.trim() !== "");
    value = JSON.stringify(cleanList.length > 0 ? cleanList : []); // Ensure empty array if all empty
  } else if (isJsonType && metafieldValues[productId]) {
    value = metafieldValues[productId];
    try {
      value = JSON.stringify(JSON.parse(value));
    } catch (e) {
      alert("Invalid JSON format for this metafield.");
      return;
    }
  } else {
    value = metafieldValues[productId] || "";
  }

  if (!value && !(isListType || isJsonType)) { // For scalar types, prompt before clearing
    if (confirm("Value is empty. Do you want to clear this metafield for this product?")) {
      handleRowClear(productId);
    }
    return;
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
      definition: selectedDef, // "namespace___key___originalType"
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


// Handle Definition Creation feedback
useEffect(() => {
  if (definitionFetcher.data?.intent === "createMetafieldDefinition") {
    if (definitionFetcher.data.success) {
      setShowCreateModal(false);
      // Optionally refresh definitions here, or reload page if needed
    } else {
      alert(definitionFetcher.data.errors?.map(e => e.message).join(", ") || "Failed to create metafield definition.");
    }
  }
}, [definitionFetcher.data]);


useEffect(() => {
  if (selectedDef) {
    const selectedObj = definitionOptions.find(d => d.value === selectedDef);
    if (selectedObj) {
      setDefSearch(selectedObj.label);
    }
  } else {
    setDefSearch("");
  }
}, [selectedDef, definitionOptions]);


  // Handle Definition Creation feedback
  useEffect(() => {
    if (definitionFetcher.data?.intent === "createMetafieldDefinition") {
      if (definitionFetcher.data.success) {
        setShowCreateModal(false);
        // Optionally, refresh the page or update definitions in state to show new def
        // For simplicity, we can reload definitions by submitting to loader.
        // This is not ideal for large numbers of definitions, but works for now.
        // A better approach would be to add the new definition to the 'definitions' state directly.
        // As remix loader doesn't re-run on action, for simplicity, we'll suggest a full reload for now.
         // Simple but effective refresh
        // Alternatively, if you want to avoid full reload:
        // setDefinitions(prev => [...prev, definitionFetcher.data.definition]);
      } else {
        alert(definitionFetcher.data.errors?.map(e => e.message).join(", ") || "Failed to create metafield definition.");
      }
    }
  }, [definitionFetcher.data]);

  useEffect(() => {
  if (selectedDef) {
    const selectedObj = definitionOptions.find(d => d.value === selectedDef);
    if (selectedObj) {
      setDefSearch(selectedObj.label);
    }
  } else {
    setDefSearch(""); // or keep empty when none selected
  }
}, [selectedDef, definitionOptions]);


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
                        background: "linear-gradient(90deg, #f8f9f8ff 0%, #efcdf8ff 100%)",
                        color: "#1e293b",
                        fontWeight: 600,
                        borderRadius: "16px",
                        padding: "6px 14px 6px 12px",
                        fontSize: "12px",
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
                      >
                        ×
                      </button>
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
                    placeholder="Search Product Name"
                    autoComplete="off"
                  />
                }
              />
            </div>

            {/* Definition Dropdown */}
            <div style={{ marginBottom: "1.5rem", display: 'flex', alignItems: 'flex-end', gap: '1rem' }}>
              <div style={{ flexGrow: 1 }}>
                <Autocomplete
                  options={filteredDefs}
                  selected={selectedDef ? [selectedDef] : []}
                  onSelect={(selected) => {
                    setSelectedDef(selected[0] || "");
                    setDefSearch("");
                    // Clear related states as needed
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
              <Button onClick={() => setShowCreateModal(true)}>
                Create New Definition
              </Button>
            </div>

            {/* Bulk Set */}
            {selectedProductIds.length > 1 && selectedDef && (
              <div style={{ marginBottom: "1.5rem" }}>
                <Text as="p" variant="bodyMd" style={{ fontWeight: 700, color: "#97530bff", marginBottom: 8 }}>
                  Bulk set value for all selected products:
                </Text>

                {selectedType === "multi_line_text_field" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {/* Bulk Input Mode Selector */}
                    <Select
                      label="Bulk Input Mode"
                      options={[
                        { label: "Plain Text", value: "plain" },
                        { label: "HTML Table", value: "html" },
                      ]}
                      value={bulkMultiTextMode}
                      onChange={(val) => {
                        setBulkMultiTextMode(val);
                        if (val !== "html") {
                          setBulkTableData([["", ""]]); // Reset table data for leaving html mode
                        } else if (!bulkTableData || bulkTableData.length === 0) {
                          setBulkTableData([["", ""]]); // Initialize for html mode
                        }
                      }}
                    />

                    {/* Plain Text Bulk Input */}
                    {bulkMultiTextMode === "plain" && (
                      <TextField
                        label="Bulk Value (Plain Text)"
                        value={bulkValue}
                        onChange={setBulkValue}
                        multiline
                        autoComplete="off"
                        fullWidth
                        placeholder="Enter plain text here"
                      />
                    )}

                    {/* HTML Table Bulk Input */}
                    {bulkMultiTextMode === "html" && (
                      <>
                        <TableBuilder
                          data={bulkTableData}
                          onChange={setBulkTableData}
                        />
                        <TextField
                          label="Generated HTML Preview"
                          multiline
                          readOnly
                          autoComplete="off"
                          value={generateTableHTML(bulkTableData)}
                          helpText="This HTML markup will be saved as the bulk metafield value."
                          style={{ marginTop: "12px", fontFamily: "monospace" }}
                          fullWidth
                        />
                      </>
                    )}
                  </div>
                ) : isListType || (isJsonType && selectedOriginalType.startsWith("LIST.")) ? (
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
                          label={idx === 0 ? <span style={{ color: "#5f2864ff", fontWeight: 700 }}>Bulk List Item</span> : undefined}
                          labelHidden={idx !== 0}
                          style={{
                            fontWeight: 700,
                            color: "#5e2a86ff",
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
                        background: "linear-gradient(90deg, #ece0b3ff 0%, #f6b4ccff 100%)",
                        color: "#000000ff",
                        border: "none",
                        padding: "6px 12px",
                        borderRadius: "4px",
                        cursor: "pointer",
                        marginTop: "0.5rem",
                        fontWeight: 700,
                        fontSize: "14px",
                        boxShadow: "0 2px 6px #fde68a50"
                      }}
                    >＋ Add List Item</button>
                  </>
                ) : selectedType === "color" ? (
                  <TextField
                    label={<span style={{ color: "#f59e42", fontWeight: 700 }}>Bulk Value (Color)</span>}
                    value={bulkValue}
                    onChange={setBulkValue}
                    type="color"
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
                ) : selectedType === "boolean" ? (
                  <Select
                    label={<span style={{ color: "#f59e42", fontWeight: 700 }}>Bulk Value (Boolean)</span>}
                    options={[
                      { label: "Select...", value: "" },
                      { label: "True", value: "true" },
                      { label: "False", value: "false" }
                    ]}
                    value={bulkValue}
                    onChange={setBulkValue}
                  />
                ) : (
                  <TextField
                    value={bulkValue}
                    onChange={setBulkValue}
                    label={<span style={{ color: "#f59e42", fontWeight: 700 }}>Bulk Value</span>}
                    autoComplete="off"
                    fullWidth
                    multiline={selectedType === "multi_line_text_field" || selectedType === "rich_text_field" || selectedType === "json"}
                    type={selectedType === "integer" || selectedType === "float" ? "number" : "text"}
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
                            {selectedType === "multi_line_text_field" ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                {/* Input mode selector */}
                                <Select
                                  label="Input Mode"
                                  options={[
                                    { label: "Plain Text", value: "plain" },
                                    { label: "HTML Table", value: "html" },
                                  ]}
                                  value={multiTextModeByProduct[pid] || "plain"}
                                  onChange={(val) => {
                                    setMultiTextModeByProduct(prev => ({ ...prev, [pid]: val }));
                                    if (val !== "html") {
                                      setTableDataByProduct(prev => {
                                        const copy = { ...prev };
                                        delete copy[pid];
                                        return copy;
                                      });
                                    } else if (!tableDataByProduct[pid]) {
                                      setTableDataByProduct(prev => ({ ...prev, [pid]: [["", ""]] }));
                                    }
                                  }}
                                />
                                {/* Plain text input */}
                                {multiTextModeByProduct[pid] === "plain" && (
                                  <TextField
                                    label="Plain Text"
                                    value={metafieldValues[pid] || ""}
                                    onChange={(val) => handleValueChange(pid, val)}
                                    multiline
                                    autoComplete="off"
                                    fullWidth
                                    placeholder="Enter plain text here"
                                  />
                                )}
                                {/* Table builder with live HTML preview */}
                                {multiTextModeByProduct[pid] === "html" && (
                                  <>
                                    <TableBuilder
                                      data={tableDataByProduct[pid] || [["", ""]]}
                                      onChange={(newTable) => setTableDataByProduct(prev => ({ ...prev, [pid]: newTable }))}
                                    />
                                    <TextField
                                      label="Generated HTML Preview"
                                      multiline
                                      readOnly
                                      value={generateTableHTML(tableDataByProduct[pid] || [["", ""]])}
                                      helpText="This HTML markup will be saved as the metafield value."
                                      style={{ marginTop: "12px", fontFamily: "monospace" }}
                                      fullWidth
                                    />
                                  </>
                                )}
                              </div>
                            ) : isListType || (isJsonType && selectedOriginalType.startsWith("LIST.")) ? (
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
                                          backgroundColor: "#f37b7bff",
                                          color: "white",
                                          border: "none",
                                          width: "28px",
                                          height: "22px",
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
                                    backgroundColor: "#7fabf0ff",
                                    color: "white",
                                    border: "none",
                                    padding: "3px 9px",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    marginTop: "0.5rem",
                                  }}
                                >＋ Add List Item</button>
                              </>
                            ) : isFileType ? (
                              <>
                                <Text as="p" variant="bodyMd">Upload File (or enter a URL)</Text>
                                <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                                  <Button
                                    onClick={() => {
                                      setUploadProductId(pid);
                                      fileInputRef.current?.click();
                                    }}
                                    disabled={uploading}
                                  >Upload File</Button>
                                  <input
                                    type="file"
                                    style={{ display: "none" }}
                                    ref={fileInputRef}
                                    onChange={e => handleFileChange(e, pid)}
                                  />
                                  {uploading && uploadProductId === pid && (
                                    <Text as="span" variant="bodySm" color="subdued">Uploading...</Text>
                                  )}
                                </div>
                                <TextField
                                  label="Metafield Value (URL)"
                                  value={value}
                                  onChange={val => handleValueChange(pid, val)}
                                  autoComplete="off"
                                  fullWidth
                                  placeholder="Paste a URL or upload a file"
                                />
                              </>
                            ) : selectedType === "boolean" ? (
                              <Select
                                label="Metafield Value"
                                options={[
                                  { label: "Select...", value: "" },
                                  { label: "True", value: "true" },
                                  { label: "False", value: "false" }
                                ]}
                                value={value}
                                onChange={val => handleValueChange(pid, val)}
                              />
                            ) : (
                              <TextField
                                label="Metafield Value"
                                value={value}
                                onChange={val => handleValueChange(pid, val)}
                                multiline={selectedType === "rich_text_field" || selectedType === "json"}
                                autoComplete="off"
                                fullWidth
                                type={selectedType === "integer" || selectedType === "float" ? "number" : "text"}
                              />
                            )}
                          </td>
                          <td style={{ padding: "8px", verticalAlign: "top" }}>
                            <Button
                              onClick={e => { e.preventDefault(); handleRowUpdate(pid); }}
                              size="slim"
                              disabled={uploading}
                            >Update</Button>
                            <Button
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
                            {successMap[pid] && <Text variant="bodyMd" color="success">✅</Text>}
                            {errorMap[pid] && <Text variant="bodyMd" color="critical">{errorMap[pid]}</Text>}
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

    {/* NEW: Metafield Definition Creation Modal */}
    <CreateMetafieldDefinitionModal
      isOpen={showCreateModal}
      onClose={() => setShowCreateModal(false)}
      onSubmit={(definitionData) => {
        const formData = new FormData();
        formData.append("intent", "createMetafieldDefinition");
        formData.append("namespace", definitionData.namespace);
        formData.append("key", definitionData.key);
        formData.append("name", definitionData.name);
        formData.append("type", reverseTypeMap[definitionData.type] || definitionData.type);
        formData.append("description", definitionData.description);
        definitionFetcher.submit(formData, { method: "post", action: "." });
      }}
      isSubmitting={definitionFetcher.state === "submitting" || definitionFetcher.state === "loading"}
      errors={definitionFetcher.data?.errors}
    />
  </Page>
);
}