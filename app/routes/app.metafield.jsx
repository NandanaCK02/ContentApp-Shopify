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
        return json({ success: false, errors: userErrors, intent: "updateMetafield" });
      }
      return json({ success: true, intent: "updateMetafield" });
    } catch (err) {
      console.error("Metafield mutation error:", err);
      return json({
        success: false,
        errors: [{ message: "Server error during metafield update." }],
        intent: "updateMetafield",
      });
    }
  } else if (intent === "getMetafieldValue") {
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

  return json({ success: false, errors: [{ message: "Invalid action intent." }] });
}

export default function ProductMetafieldEditor() {
  const { products, definitions } = useLoaderData();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);

  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedDef, setSelectedDef] = useState("");
  const [value, setValue] = useState("");
  const [listValues, setListValues] = useState([""]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "updateMetafield") {
      setProductSearch("");
      setSelectedProductId("");
      setSelectedDef("");
      setValue("");
      setListValues([""]);
      setUploading(false);
    }
  }, [fetcher.data]);

  const productOptions = useMemo(
    () => products.map((product) => ({ label: product.title, value: product.id })),
    [products]
  );

  const filteredProductOptions = useMemo(() => {
    if (!productSearch) return productOptions.slice(0, 20);
    return productOptions.filter((option) =>
      option.label.toLowerCase().includes(productSearch.toLowerCase())
    );
  }, [productSearch, productOptions]);

  const handleProductSelect = useCallback(
    (selected) => {
      const id = selected[0];
      const selectedProduct = productOptions.find((p) => p.value === id);
      setProductSearch(selectedProduct?.label || "");
      setSelectedProductId(id);
      setSelectedDef("");
      setValue("");
      setListValues([""]);
    },
    [productOptions]
  );

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

  useEffect(() => {
    if (selectedProductId && selectedDef) {
      setValue("");
      setListValues([""]);
      fetcher.submit(
        {
          intent: "getMetafieldValue",
          productId: selectedProductId,
          definition: selectedDef,
        },
        { method: "post", action: "." }
      );
    }
  }, [selectedProductId, selectedDef]);

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "getMetafieldValue") {
      const fetchedValue = fetcher.data.value;
      const fetchedOriginalType = fetcher.data.originalType;

      if (fetchedValue !== null && fetchedValue !== undefined) {
        if (fetchedOriginalType.startsWith("LIST.")) {
          try {
            const parsedValue = JSON.parse(fetchedValue);
            if (Array.isArray(parsedValue)) {
              setListValues(parsedValue.length > 0 ? parsedValue : [""]);
            } else {
              setListValues([fetchedValue]);
            }
          } catch (e) {
            setListValues([fetchedValue]);
          }
        } else if (fetchedOriginalType === "JSON") {
          try {
            const parsedValue = JSON.parse(fetchedValue);
            if (Array.isArray(parsedValue)) {
              setListValues(parsedValue.length > 0 ? parsedValue : [""]);
              setValue("");
            } else {
              setValue(fetchedValue);
              setListValues([""]);
            }
          } catch (e) {
            setValue(fetchedValue);
            setListValues([""]);
          }
        } else {
          setValue(fetchedValue);
          setListValues([""]);
        }
      } else {
        setValue("");
        setListValues([""]);
      }
    }
  }, [fetcher.data]);

  // Only set the value after upload, don't auto-save!
  useEffect(() => {
    if (
      fetcher.data?.intent === "uploadFile" &&
      fetcher.data?.success &&
      selectedProductId &&
      selectedDef
    ) {
      const uploadedFileUrl = fetcher.data.url;
      setValue(uploadedFileUrl);
      // No auto-submit!
    }
  }, [fetcher.data, selectedProductId, selectedDef]);

  useEffect(() => {
    if (fetcher.data?.intent === "uploadFile") {
      setUploading(false);
      if (!fetcher.data?.success) {
        alert(fetcher.data.error || "Failed to upload file.");
        setValue("");
      }
    }
  }, [fetcher.data]);

  const handleListValueChange = useCallback((index, val) => {
    const updated = [...listValues];
    updated[index] = val;
    setListValues(updated);
  }, [listValues]);

  const handleAddListItem = useCallback(() => {
    setListValues([...listValues, ""]);
  }, [listValues]);

  const handleRemoveListItem = useCallback((index) => {
    const updated = [...listValues];
    updated.splice(index, 1);
    setListValues(updated.length > 0 ? updated : [""]);
  }, [listValues]);

  let finalValueForSubmission = value;
  if (isListType || (isJsonType && Array.isArray(listValues) && listValues.length > 0 && listValues.some(v => v.trim() !== ""))) {
    finalValueForSubmission = JSON.stringify(listValues.filter((v) => v.trim() !== ""));
  } else if (isJsonType && value) {
    finalValueForSubmission = value;
  }

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (file) {
      setUploading(true);
      setValue("Uploading...");
      const formData = new FormData();
      formData.append("file", file);
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  };

  return (
    <Page title="✏️ Update Product Metafield Value">
      <Layout>
        <Layout.Section>
          <Card sectioned spacing="loose">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="updateMetafield" />

              {/* Product Search */}
              <div style={{ marginBottom: "1.5rem" }}>
                <Autocomplete
                  options={filteredProductOptions}
                  selected={selectedProductId ? [selectedProductId] : []}
                  onSelect={handleProductSelect}
                  textField={
                    <Autocomplete.TextField
                      label="Search Product"
                      value={productSearch}
                      onChange={setProductSearch}
                      placeholder="Start typing a product name"
                      autoComplete="off"
                    />
                  }
                />
                <input type="hidden" name="productId" value={selectedProductId || ""} />
              </div>

              {/* Definition Dropdown */}
              <div style={{ marginBottom: "1.5rem" }}>
                <Select
                  label="Metafield Definition"
                  options={definitionOptions}
                  onChange={(value) => {
                    setSelectedDef(value);
                    setValue("");
                    setListValues([""]);
                  }}
                  value={selectedDef}
                  placeholder="Select a metafield definition"
                />
                <input type="hidden" name="definition" value={selectedDef || ""} />
              </div>

              {/* Value Field (conditionally rendered) */}
              <div style={{ marginBottom: "1.5rem" }}>
                {selectedDef && (
                  <>
                    {isListType || (isJsonType && Array.isArray(listValues) && listValues.length > 0 && listValues.some(v => v.trim() !== "")) ? (
                      <>
                        {listValues.map((item, index) => (
                          <div
                            key={index}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              width: "100%",
                              marginBottom: "0.5rem",
                            }}
                          >
                            <div style={{ flexGrow: 1 }}>
                              <TextField
                                value={item}
                                onChange={(val) => handleListValueChange(index, val)}
                                multiline
                                autoComplete="off"
                                fullWidth
                                label={index === 0 ? "Metafield Value (List Item)" : undefined}
                                labelHidden={index !== 0}
                              />
                            </div>
                            {listValues.length > 1 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveListItem(index)}
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
                              >
                                −
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={handleAddListItem}
                          style={{
                            backgroundColor: "#3b82f6",
                            color: "white",
                            border: "none",
                            padding: "6px 12px",
                            borderRadius: "4px",
                            cursor: "pointer",
                            marginTop: "0.5rem",
                          }}
                        >
                          ＋ Add List Item
                        </button>
                      </>
                    ) : selectedType === "color" ? (
                      <label>
                        <Text as="p" variant="bodyMd">Metafield Value</Text>
                        <input
                          type="color"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          style={{ width: "100px", height: "40px", border: "1px solid #c4c4c4", borderRadius: "4px" }}
                        />
                      </label>
                    ) : selectedType === "url" ? (
                      <>
                        <Text as="p" variant="bodyMd">Upload PDF (or enter a URL)</Text>
                        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                          <Button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                          >
                            Upload PDF
                          </Button>
                          <input
                            type="file"
                            accept="application/pdf"
                            style={{ display: "none" }}
                            ref={fileInputRef}
                            onChange={handleFileChange}
                          />
                          {uploading && (
                            <Text as="span" variant="bodySm" color="subdued">
                              Uploading...
                            </Text>
                          )}
                        </div>
                        <TextField
                          label="Metafield Value (URL)"
                          value={value}
                          onChange={setValue}
                          autoComplete="off"
                          fullWidth
                          placeholder="Paste a URL or upload a PDF"
                        />
                      </>
                    ) : (
                      <TextField
                        label="Metafield Value"
                        value={value}
                        onChange={setValue}
                        multiline
                        autoComplete="off"
                        fullWidth
                      />
                    )}
                    <input type="hidden" name="value" value={finalValueForSubmission} />
                  </>
                )}
              </div>

              {/* Save Button */}
              <Button
                submit
                primary
                loading={fetcher.state === "submitting" || fetcher.state === "loading"}
                disabled={
                  !selectedProductId ||
                  !selectedDef ||
                  (selectedDef && !finalValueForSubmission) ||
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
                Save Metafield
              </Button>

              {/* Success Message */}
              {fetcher.data?.success && fetcher.data?.intent === "updateMetafield" && (
                <Text variant="bodyMd" color="success" as="p" style={{ marginTop: "1rem" }}>
                  ✅ Metafield saved successfully!
                </Text>
              )}

              {/* Error Messages */}
              {fetcher.data?.errors && (
                <div style={{ marginTop: "1rem", color: "red" }}>
                  <strong>Errors:</strong>
                  <ul>
                    {fetcher.data.errors.map((err, i) => (
                      <li key={i}>{err.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </fetcher.Form>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
