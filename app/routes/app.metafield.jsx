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
import { useState, useCallback, useMemo } from "react";

const typeMap = {
  STRING: "single_line_text_field",
  INTEGER: "number_integer",
  BOOLEAN: "boolean",
  JSON: "json",
  DATE: "date",
  DATETIME: "date_time",
  FLOAT: "number_decimal",
  "LIST.STRING": "list.single_line_text_field",
  "LIST.INTEGER": "list.number_integer",
  "LIST.BOOLEAN": "list.boolean",
  "LIST.JSON": "list.json",
};

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const [productsRes, defsRes] = await Promise.all([
    admin.graphql(`{
      products(first: 100) {
        edges {
          node {
            id
            title
          }
        }
      }
    }`),
    admin.graphql(`{
      metafieldDefinitions(first: 20, ownerType: PRODUCT) {
        edges {
          node {
            name
            namespace
            key
            type { name }
            id
          }
        }
      }
    }`),
  ]);

  const productsData = await productsRes.json();
  const defsData = await defsRes.json();

  const products = productsData?.data?.products?.edges.map((e) => e.node) || [];
  const definitions =
    defsData?.data?.metafieldDefinitions?.edges.map((e) => {
      let typeKey = e.node.type.name;
      if (typeKey.startsWith("LIST.")) {
        typeKey = "LIST." + typeKey.split(".")[1];
      }
      return {
        ...e.node,
        type: typeMap[typeKey] || e.node.type.name,
        originalType: e.node.type.name,
      };
    }) || [];

  return json({ products, definitions });
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const intent = form.get("intent");

  if (intent === "createDefinition") {
    const newNamespace = form.get("newNamespace");
    const newKey = form.get("newKey");
    const newName = form.get("newName");
    const newType = form.get("newType");

    const mutation = `
      mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      definition: {
        name: newName,
        namespace: newNamespace,
        key: newKey,
        type: newType,
        ownerType: "PRODUCT",
      },
    };

    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    const userErrors = result?.data?.metafieldDefinitionCreate?.userErrors || [];
    if (userErrors.length > 0) {
      return json({ success: false, errors: userErrors });
    }

    return json({ success: true });
  }

  const productId = form.get("productId");
  const definition = form.get("definition");
  const value = form.get("value");

  if (!productId || !definition || !value) {
    return json({
      success: false,
      errors: [{ message: "All fields are required." }],
    });
  }

  const [namespace, key, originalType] = definition.split("___");
  let metafieldValue = value;

  try {
    if (originalType.startsWith("list.")) {
      JSON.parse(value);
    } else if (originalType === "json") {
      JSON.parse(value);
    }
  } catch {
    metafieldValue = JSON.stringify([value]);
  }

  metafieldValue = String(metafieldValue);

  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key namespace value type }
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
        value: metafieldValue,
      },
    ],
  };

  try {
    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    const userErrors = result?.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return json({ success: false, errors: userErrors });
    }

    return json({ success: true });
  } catch (err) {
    console.error("Unhandled exception in mutation:", err);
    return json({
      success: false,
      errors: [{ message: "Internal server error during metafield mutation." }],
    });
  }
}

export default function ProductMetafieldEditor() {
  const { products, definitions } = useLoaderData();
  const fetcher = useFetcher();

  const [productSearch, setProductSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedDef, setSelectedDef] = useState("");
  const [value, setValue] = useState("");
  const [newNamespace, setNewNamespace] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("single_line_text_field");

  const productOptions = useMemo(
    () =>
      products.map((product) => ({ label: product.title, value: product.id })),
    [products]
  );

  const filteredProductOptions = useMemo(
    () =>
      productOptions.filter((option) =>
        option.label.toLowerCase().includes(productSearch.toLowerCase())
      ),
    [productSearch, productOptions]
  );

  const handleProductSelect = useCallback(
    (selected) => {
      const id = selected[0];
      const selectedProduct = productOptions.find((p) => p.value === id);
      setProductSearch(selectedProduct?.label || "");
      setSelectedProductId(id);
    },
    [productOptions]
  );

  const definitionOptions = definitions.map((def) => ({
    label: `${def.name} (${def.namespace}.${def.key}) [${def.originalType}]`,
    value: `${def.namespace}___${def.key}___${def.originalType}`,
  }));

  return (
    <Page title="Product Metafield Editor">
      <Layout>
        <Layout.Section>
          <Text variant="headingLg" as="h2" alignment="start" tone="strong" style={{ marginBottom: "1rem" }}>
            🧱 Create a New Metafield Definition
          </Text>
          <Card sectioned>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="createDefinition" />
              <TextField label="Namespace" name="newNamespace" value={newNamespace} onChange={setNewNamespace} />
              <TextField label="Key" name="newKey" value={newKey} onChange={setNewKey} />
              <TextField label="Name" name="newName" value={newName} onChange={setNewName} />
              <Select
                label="Type"
                name="newType"
                value={newType}
                onChange={setNewType}
                options={Object.values(typeMap).map((type) => ({ label: type, value: type }))}
              />
              <Button submit primary>Create Metafield Definition</Button>
            </fetcher.Form>
          </Card>

          <div style={{ height: "2rem" }} />

          <Text variant="headingLg" as="h2" alignment="start" tone="strong" style={{ marginBottom: "1rem" }}>
            ✏️ Update Product Metafield
          </Text>
          <Card sectioned>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="updateMetafield" />
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
                  />
                }
              />
              <input type="hidden" name="productId" value={selectedProductId || ""} />

              <Select
                label="Metafield Definition"
                options={definitionOptions}
                onChange={setSelectedDef}
                value={selectedDef}
              />
              <input type="hidden" name="definition" value={selectedDef || ""} />

              <TextField
                label="Metafield Value"
                value={value}
                onChange={setValue}
                name="value"
                helpText={
                  selectedDef && selectedDef.includes("list.")
                    ? 'For list types, enter a JSON array (e.g. ["a","b"]) or a single value.'
                    : selectedDef && selectedDef.includes("json")
                    ? 'Enter valid JSON (e.g. {"key": "value"})'
                    : undefined
                }
              />

              <Button submit primary style={{ marginTop: "1rem" }}>
                Save Metafield
              </Button>
            </fetcher.Form>

            {fetcher.data?.success && (
              <Text variant="bodyMd" color="success" as="p" style={{ marginTop: "1rem" }}>
                ✅ Operation completed successfully!
              </Text>
            )}

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
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
