// app/routes/app.collection.jsx

import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
} from "@shopify/polaris";
import { json } from "@remix-run/node";
import { useActionData, Form as RemixForm } from "@remix-run/react";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const title = formData.get("title");
  const condition = formData.get("condition");

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

  const variables = {
    input: {
      title: title,
      ruleSet: {
        appliedDisjunctively: false, // AND logic
        rules: [
          {
            column: "TAG",         // Can also be TITLE, TYPE, VENDOR, etc.
            relation: "EQUALS",    // Use CONTAINS, STARTS_WITH, etc. if needed
            condition: condition,
          },
        ],
      },
    },
  };

  try {
    const response = await admin.graphql(mutation, { variables });
    const result = await response.json();

    if (result?.data?.collectionCreate?.userErrors?.length > 0) {
      return json(
        { error: result.data.collectionCreate.userErrors[0].message },
        { status: 400 }
      );
    }

    return json({
      success: true,
      collection: result.data.collectionCreate.collection,
    });
  } catch (error) {
    console.error("Error creating smart collection:", error);
    return json({ error: "Something went wrong." }, { status: 500 });
  }
};

export default function CreateSmartCollection() {
  const actionData = useActionData();

  return (
    <Page title="Create Smart Collection">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <RemixForm method="post">
              <FormLayout>
                <TextField
                  label="Collection Title"
                  name="title"
                  required
                  autoComplete="off"
                />
                <TextField
                  label="Tag Condition"
                  name="condition"
                  required
                  helpText="e.g., 'summer', 'sale', etc. — matches product tags"
                />
                <Button submit primary>
                  Create Collection
                </Button>

                {actionData?.error && (
                  <p style={{ color: "red" }}>{actionData.error}</p>
                )}
                {actionData?.success && (
                  <p style={{ color: "green" }}>
                    ✅ Collection "{actionData.collection.title}" created!
                  </p>
                )}
              </FormLayout>
            </RemixForm>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
