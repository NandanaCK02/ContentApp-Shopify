// app/routes/app/create-collection.jsx

import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Select,
  Form,
  InlineError,
  Button,
  Text,
  ChoiceList,
  Autocomplete,
  Icon,
  Tag,
} from "@shopify/polaris";
import * as PolarisIcons from "@shopify/polaris-icons";
import {
  useNavigation,
  Form as RemixForm,
  useFetcher,
  useActionData,
} from "@remix-run/react";
import { useState, useEffect, useCallback } from "react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server"; // ✅ update this if necessary

// ✅ Loader — Handles product autocomplete via GraphQL
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("searchQuery");

  if (searchQuery && searchQuery.length > 2) {
    const result = await admin.graphql(`
      query Products($query: String!) {
        products(first: 10, query: $query) {
          edges {
            node { id title }
          }
        }
      }
    `, {
      variables: {
        query: `title:*${searchQuery}*`,
      },
    });

    const jsonRes = await result.json();
    const products = jsonRes?.data?.products?.edges?.map(edge => edge.node) || [];
    return json({ products });
  }

  return json({ products: [] });
}

// ✅ Action — Creates a smart or manual collection and assigns products
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const title = form.get("title");
  const description = form.get("description");
  const published = form.get("published") === "true";
  const collectionType = form.get("collectionType");
  const ruleField = form.get("ruleField");
  const ruleRelation = form.get("ruleRelation");
  const ruleCondition = form.get("ruleCondition");
  const selectAllProducts = form.get("selectAllProducts") === "true";
  const selectedProductIds = JSON.parse(form.get("selectedProductIds") || "[]");

  try {
    let collection = null;
    let assignmentMessage = "";

    if (collectionType === "smart" || selectAllProducts) {
      const input = {
        title,
        bodyHtml: description,
        published,
        rules: [
          {
            column: selectAllProducts ? "TITLE" : ruleField,
            relation: selectAllProducts ? "NOT_EQUALS" : ruleRelation,
            condition: selectAllProducts ? "__no-match__" : ruleCondition,
          },
        ],
      };

      const gqlRes = await admin.graphql(`
        mutation smartCollectionCreate($input: SmartCollectionInput!) {
          smartCollectionCreate(input: $input) {
            smartCollection { id title }
            userErrors { message field }
          }
        }
      `, { variables: { input } });

      const { data, errors } = await gqlRes.json();
      const smart = data.smartCollectionCreate;

      if (smart.userErrors.length > 0) {
        return json({ success: false, errors: smart.userErrors });
      }

      collection = smart.smartCollection;
      assignmentMessage = "Created smart collection.";
    } else {
      // Manual collection
      const manualRes = await admin.graphql(`
        mutation collectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id title }
            userErrors { message }
          }
        }
      `, {
        variables: {
          input: {
            title,
            descriptionHtml: description,
            published
          }
        }
      });

      const { data } = await manualRes.json();
      const create = data.collectionCreate;

      if (create.userErrors.length > 0) {
        return json({ success: false, errors: create.userErrors });
      }

      collection = create.collection;

      if (selectedProductIds.length > 0) {
        const assignRes = await admin.graphql(`
          mutation Assign($collectionId: ID!, $productIds: [ID!]!) {
            collectionAddProductsV2(collectionId: $collectionId, productIds: $productIds) {
              userErrors { message }
            }
          }
        `, {
          variables: {
            collectionId: collection.id,
            productIds: selectedProductIds
          }
        });

        const data = await assignRes.json();
        const assignErrors = data?.data?.collectionAddProductsV2?.userErrors;

        if (assignErrors.length > 0) {
          return json({
            success: true,
            collection,
            productAssignmentStatus: `Collection created but assigning products failed: ${assignErrors.map(e => e.message).join(", ")}`,
          });
        }

        assignmentMessage = `${selectedProductIds.length} product(s) assigned.`;
      } else {
        assignmentMessage = "Manual collection created without products.";
      }
    }

    return json({
      success: true,
      collection,
      productAssignmentStatus: assignmentMessage,
    });
  } catch (error) {
    console.error("Collection creation error:", error);
    return json({
      success: false,
      errors: [{ message: "Unexpected error creating collection." }],
    });
  }
}

// ✅ Component — UI rendering using Polaris
export default function CreateCollectionPage() {
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const actionData = useActionData();
  const isSubmitting = navigation.state === "submitting";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [published, setPublished] = useState("true");
  const [collectionType, setCollectionType] = useState(["manual"]);
  const [ruleField, setRuleField] = useState("TITLE");
  const [ruleRelation, setRuleRelation] = useState("EQUALS");
  const [ruleCondition, setRuleCondition] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [productOptions, setProductOptions] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [selectAllProducts, setSelectAllProducts] = useState(false);

  useEffect(() => {
    if (searchValue.length > 2) {
      fetcher.load(`/app/create-collection?index&searchQuery=${searchValue}`);
    }
  }, [searchValue]);

  useEffect(() => {
    if (fetcher.data?.products) {
      setProductOptions(fetcher.data.products.map(p => ({ label: p.title, value: p.id })));
    }
  }, [fetcher.data]);

  const handleSelect = useCallback((selected) => {
    const id = selected[0];
    const match = productOptions.find(p => p.value === id);
    if (match && !selectedProducts.some(p => p.id === id)) {
      setSelectedProducts(prev => [...prev, { id, title: match.label }]);
    }
    setSearchValue("");
  }, [productOptions, selectedProducts]);

  const handleRemoveProduct = (id) => {
    setSelectedProducts((prev) => prev.filter((p) => p.id !== id));
  };

  return (
    <Page title="Create Collection">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <RemixForm method="post">
              <FormLayout>
                {
                  actionData?.errors &&
                  actionData.errors.map((err, idx) => (
                    <InlineError key={idx} message={err.message} fieldID={`error-${idx}`} />
                  ))
                }

                <TextField label="Title" value={title} onChange={setTitle} name="title" requiredIndicator />
                <TextField label="Description" value={description} onChange={setDescription} name="description" multiline />

                <Select
                  label="Published"
                  name="published"
                  value={published}
                  onChange={setPublished}
                  options={[
                    { label: "Published", value: "true" },
                    { label: "Unpublished", value: "false" }
                  ]}
                />

                <ChoiceList
                  title="Collection Type"
                  selected={collectionType}
                  onChange={setCollectionType}
                  choices={[
                    { label: "Manual", value: "manual" },
                    { label: "Smart", value: "smart" }
                  ]}
                />

                {collectionType.includes("smart") && (
                  <>
                    <Select
                      label="Rule Field"
                      name="ruleField"
                      options={[
                        { label: "Title", value: "TITLE" },
                        { label: "Tag", value: "TAG" },
                        { label: "Type", value: "PRODUCT_TYPE" },
                        { label: "Vendor", value: "VENDOR" },
                      ]}
                      value={ruleField}
                      onChange={setRuleField}
                    />
                    <Select
                      label="Rule Relation"
                      name="ruleRelation"
                      options={[
                        { label: "Equals", value: "EQUALS" },
                        { label: "Not Equals", value: "NOT_EQUALS" },
                        { label: "Contains", value: "CONTAINS" },
                        { label: "Not Contains", value: "NOT_CONTAINS" }
                      ]}
                      value={ruleRelation}
                      onChange={setRuleRelation}
                    />
                    <TextField
                      label="Rule Condition"
                      value={ruleCondition}
                      onChange={setRuleCondition}
                      name="ruleCondition"
                    />
                  </>
                )}

                {collectionType.includes("manual") && (
                  <>
                    <Autocomplete
                      options={productOptions}
                      selected={[]}
                      onSelect={handleSelect}
                      textField={
                        <TextField
                          label="Search Products"
                          value={searchValue}
                          onChange={setSearchValue}
                          clearButton
                          onClearButtonClick={() => setSearchValue("")}
                          prefix={<Icon source={PolarisIcons.SearchMinor} />}
                        />
                      }
                    />
                    {selectedProducts.map((product) => (
                      <Tag key={product.id} onRemove={() => handleRemoveProduct(product.id)}>
                        {product.title}
                      </Tag>
                    ))}
                    <input
                      type="hidden"
                      name="selectedProductIds"
                      value={JSON.stringify(selectedProducts.map((p) => p.id))}
                    />
                  </>
                )}

                <ChoiceList
                  title="Assign All Products"
                  selected={selectAllProducts ? ["all"] : []}
                  onChange={(val) => {
                    setSelectAllProducts(val.includes("all"));
                    setCollectionType(["smart"]);
                  }}
                  choices={[
                    { label: "Assign all store products automatically", value: "all" }
                  ]}
                />

                <input type="hidden" name="collectionType" value={collectionType[0]} />
                <input type="hidden" name="selectAllProducts" value={selectAllProducts.toString()} />
                <input type="hidden" name="intent" value="createCollection" />

                <Button submit primary loading={isSubmitting}>
                  Create Collection
                </Button>
              </FormLayout>
            </RemixForm>
          </Card>

          {actionData?.success && (
            <Card sectioned>
              <Text as="p" variant="bodyMd">✅ Created collection: {actionData.collection?.title}</Text>
              <Text tone="success">{actionData.productAssignmentStatus}</Text>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
