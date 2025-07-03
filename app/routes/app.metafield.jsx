import { json } from "@remix-run/node";
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
import { useState, useCallback, useMemo, useEffect } from "react";

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
          originalType: e.node.type.name, // Store original Shopify type name
        };
      })
    );
    hasNextPage = data?.data?.metafieldDefinitions?.pageInfo?.hasNextPage;
    if (hasNextPage) defCursor = edges[edges.length - 1].cursor;
  }

  return json({ products, definitions });
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "updateMetafield") {
    const productId = form.get("productId");
    const definition = form.get("definition"); // "namespace___key___originalType"
    const value = form.get("value"); // This value is already prepared by the frontend

    if (!productId || !definition || value === null) {
      return json({ success: false, errors: [{ message: "Product ID, definition, and value are required." }], intent: "updateMetafield" });
    }

    const [namespace, key, originalType] = definition.split("___");

   const mutation = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
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


    const variables = {
      metafields: [
        {
          ownerId: productId,
          namespace,
          key,
          type: originalType, // Use the original Shopify type name for the mutation
          value: value, // Use the prepared value directly
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
    const definition = form.get("definition"); // "namespace___key___originalType"

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
  const fetcher = useFetcher(); // Use useFetcher for client-side data mutations/fetches

  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedDef, setSelectedDef] = useState("");
  const [value, setValue] = useState(""); // State for single value metafields
  const [listValues, setListValues] = useState([""]); // State for list metafields

  // Effect to clear form and show success message after successful update
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "updateMetafield") {
      // Clear form inputs after a successful update
      setProductSearch("");
      setSelectedProductId("");
      setSelectedDef("");
      setValue("");
      setListValues([""]);
      // You can add a Polaris Toast for better UX here if needed
    }
  }, [fetcher.data]);

  const productOptions = useMemo(
    () => products.map((product) => ({ label: product.title, value: product.id })),
    [products]
  );

  const filteredProductOptions = useMemo(() => {
    if (!productSearch) return productOptions.slice(0, 20); // Limit initial display
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
      setSelectedDef(""); // Clear definition when product changes
      setValue(""); // Clear value when product changes
      setListValues([""]); // Clear list values when product changes
    },
    [productOptions]
  );

  const definitionOptions = definitions.map((def) => ({
    label: `${def.name} (${def.namespace}.${def.key})`,
    value: `${def.namespace}___${def.key}___${def.originalType}`, // Include originalType for action
    type: def.originalType, // Store originalType for client-side logic
  }));

  const selectedDefObj = definitionOptions.find((d) => d.value === selectedDef);
  const selectedType = selectedDefObj?.type || ""; // Shopify's original type (e.g., "SINGLE_LINE_TEXT_FIELD", "LIST.STRING", "JSON")

  // Determine if the currently selected definition is a list type
  const isListType = selectedType.startsWith("list.");
  // Determine if the currently selected definition is a JSON type
  const isJsonType = selectedType === "json";

  // Effect to fetch metafield value when product or definition changes
  useEffect(() => {
    if (selectedProductId && selectedDef) {
      // Clear current value displays before fetching new ones
      setValue("");
      setListValues([""]);

      // Trigger fetcher to get current metafield value
      fetcher.submit(
        {
          intent: "getMetafieldValue",
          productId: selectedProductId,
          definition: selectedDef,
        },
        { method: "post", action: "." } // Action to the current route's action function
      );
    }
  }, [selectedProductId, selectedDef]);

  // Effect to populate value fields when fetcher data arrives from "getMetafieldValue" intent
  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.intent === "getMetafieldValue") {
      const fetchedValue = fetcher.data.value;
      const fetchedOriginalType = fetcher.data.originalType;

      if (fetchedValue !== null && fetchedValue !== undefined) {
        if (fetchedOriginalType.startsWith("list.")) {
          try {
            const parsedValue = JSON.parse(fetchedValue);
            if (Array.isArray(parsedValue)) {
              // Ensure there's at least one empty string if the list is empty for adding new items easily
              setListValues(parsedValue.length > 0 ? parsedValue : [""]);
            } else {
              // Fallback for malformed list JSON, treat as a single item
              setListValues([fetchedValue]);
            }
          } catch (e) {
            console.error("Failed to parse list metafield value:", e);
            setListValues([fetchedValue]); // Fallback to single item if JSON parsing fails
          }
        } else if (fetchedOriginalType === "json") {
          try {
            const parsedValue = JSON.parse(fetchedValue);
            // If JSON is an array, treat as list. Otherwise, treat as single string.
            if (Array.isArray(parsedValue)) {
              setListValues(parsedValue.length > 0 ? parsedValue : [""]);
              setValue(""); // Ensure single value field is clear
            } else {
              setValue(fetchedValue); // Display raw JSON string for non-array JSON
              setListValues([""]); // Ensure list field is clear
            }
          } catch (e) {
            console.error("Failed to parse JSON metafield value:", e);
            setValue(fetchedValue); // Display raw string if JSON parsing fails
            setListValues([""]); // Ensure list field is clear
          }
        } else {
          // For single value types (STRING, INTEGER, BOOLEAN, etc.)
          setValue(fetchedValue);
          setListValues([""]); // Ensure list field is clear
        }
      } else {
        // Metafield does not exist or has no value, reset inputs
        setValue("");
        setListValues([""]);
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
    // If all items are removed, add an empty one back to allow adding new items easily
    setListValues(updated.length > 0 ? updated : [""]);
  }, [listValues]);

  // Determine the final value to submit based on type and input state
  let finalValueForSubmission = value;
  if (isListType || (isJsonType && Array.isArray(listValues) && listValues.length > 0 && listValues.some(v => v.trim() !== ""))) {
    // If it's a list type, or a JSON type currently being edited as a list
    finalValueForSubmission = JSON.stringify(listValues.filter((v) => v.trim() !== ""));
  } else if (isJsonType && value) {
    // If it's a JSON type being edited as a single string
    // Shopify expects a string for the value, and validates its JSON format
    finalValueForSubmission = value;
  }
  // For other types, finalValueForSubmission remains 'value'

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
                    setValue(""); // Clear current value immediately
                    setListValues([""]); // Clear list values immediately
                  }}
                  value={selectedDef}
                  placeholder="Select a metafield definition"
                />
                <input type="hidden" name="definition" value={selectedDef || ""} />
              </div>

              {/* Value Field (conditionally rendered) */}
              <div style={{ marginBottom: "1.5rem" }}>
                {selectedDef && ( // Only show value input if a definition is selected
                  <>
                    {isListType || (isJsonType && Array.isArray(listValues) && listValues.length > 0 && listValues.some(v => v.trim() !== "")) ? (
                      // Render for list types or JSON types being treated as lists
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
                                labelHidden={index !== 0} // Hide label for subsequent items
                              />
                            </div>
                            {listValues.length > 1 && ( // Only show remove button if more than one item
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
                      // Render for color type
                      <label>
                        <Text as="p" variant="bodyMd">Metafield Value</Text>
                        <input
                          type="color"
                          value={value}
                          onChange={(e) => setValue(e.target.value)}
                          style={{ width: "100px", height: "40px", border: "1px solid #c4c4c4", borderRadius: "4px" }}
                        />
                      </label>
                    ) : (
                      // Render for all other single value types
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
                loading={fetcher.state === "submitting" || fetcher.state === "loading"} // Show loading for both submission and fetching
                disabled={!selectedProductId || !selectedDef || fetcher.state === "submitting" || fetcher.state === "loading"} // Disable if product/def not selected or fetching/submitting
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