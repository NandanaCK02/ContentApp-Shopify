import { json, redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Select,
  Button,
  TextField,
  Layout,
  FormLayout,
  ResourceList,
  ResourceItem,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import prisma from "../db.server";

//  Loader: Fetch collections, pages, and FAQs
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const collectionQuery = `query {
    collections(first: 50) {
      edges {
        node {
          id
          title
        }
      }
    }
  }`;
  const collectionRes = await admin.graphql(collectionQuery);
  const collectionData = await collectionRes.json();

  const collections = collectionData?.data?.collections?.edges?.map(({ node }) => ({
    id: node.id,
    title: node.title,
  })) || [];

  const pageQuery = `query {
    pages(first: 50) {
      edges {
        node {
          id
          title
        }
      }
    }
  }`;
  const pageRes = await admin.graphql(pageQuery);
  const pageData = await pageRes.json();

  const pages = pageData?.data?.pages?.edges?.map(({ node }) => ({
    id: node.id,
    title: node.title,
  })) || [];

  let faqs = [];
  try {
    faqs = await prisma.faq.findMany();
  } catch (error) {
    console.error("Error fetching FAQs from Prisma:", error);
  }

  return json({ collections, pages, faqs });
}

// Action: Add, Update, Delete FAQ
export async function action({ request }) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    await prisma.faq.create({
      data: {
        question: formData.get("question"),
        answer: formData.get("answer"),
        resourceId: formData.get("id"),
        resourceType: formData.get("resourceType"),
      },
    });
    return redirect("/app/faq");
  }

  if (intent === "update") {
    const faqId = String(formData.get("faqId"));
    await prisma.faq.update({
      where: { id: faqId },
      data: {
        question: formData.get("question"),
        answer: formData.get("answer"),
      },
    });
    return json({ status: "updated" });
  }

  if (intent === "delete") {
    const faqId = String(formData.get("faqId"));
    await prisma.faq.delete({
      where: { id: faqId },
    });
    return json({ status: "deleted" });
  }

  return json({ status: "unknown" });
}

// Component: FAQ Management UI
export default function FAQManagement() {
  const { collections, pages, faqs } = useLoaderData();
  const [resourceType, setResourceType] = useState("collections");
  const [selectedItem, setSelectedItem] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [editingFaqId, setEditingFaqId] = useState(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");

  const fetcher = useFetcher();

  const resources = resourceType === "collections" ? collections : pages;

  const filteredFaqs = faqs.filter(
    (faq) =>
      faq.resourceId === selectedItem?.id &&
      faq.resourceType === resourceType
  );

  // Reset new FAQ form after creation
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.status === "created") {
      setQuestion("");
      setAnswer("");
    }
  }, [fetcher.state, fetcher.data]);

  // Reset edit FAQ form after update
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.status === "updated") {
      setEditingFaqId(null);
      setEditQuestion("");
      setEditAnswer("");
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Page title="FAQ Management">
      <Layout>
        <Layout.Section>
          <Card title="Select Resource Type" sectioned>
            <Select
              label="Resource Type"
              options={[
                { label: "Collections", value: "collections" },
                { label: "Pages", value: "pages" },
              ]}
              onChange={(value) => {
                setResourceType(value);
                setSelectedItem(null);
              }}
              value={resourceType}
            />
          </Card>

          <Card
            title={`Select a ${resourceType === "collections" ? "Collection" : "Page"}`}
            sectioned
          >
            <ResourceList
              items={resources}
              renderItem={(item) => (
                <ResourceItem
                  id={item.id}
                  accessibilityLabel={`View FAQs for ${item.title}`}
                  onClick={() => setSelectedItem(item)}
                >
                  <h3>{item.title}</h3>
                </ResourceItem>
              )}
            />
          </Card>

          {selectedItem && (
            <Card title={`FAQs for: ${selectedItem.title}`} sectioned>
              {filteredFaqs.length > 0 ? (
                filteredFaqs.map((faq) => (
                  <Card key={faq.id} sectioned>
                    {editingFaqId === faq.id ? (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="update" />
                        <input type="hidden" name="faqId" value={faq.id} />
                        <FormLayout>
                          <TextField
                            label="Edit Question"
                            name="question"
                            value={editQuestion}
                            onChange={setEditQuestion}
                          />
                          <TextField
                            label="Edit Answer"
                            name="answer"
                            value={editAnswer}
                            onChange={setEditAnswer}
                            multiline
                          />
                          <Button submit primary>Save</Button>
                          <Button
                            onClick={() => setEditingFaqId(null)}
                            tone="secondary"
                          >
                            Cancel
                          </Button>
                        </FormLayout>
                      </fetcher.Form>
                    ) : (
                      <>
                        <p><strong>Q:</strong> {faq.question}</p>
                        <p><strong>A:</strong> {faq.answer}</p>
                        <Button
                          onClick={() => {
                            setEditingFaqId(faq.id);
                            setEditQuestion(faq.question);
                            setEditAnswer(faq.answer);
                          }}
                          tone="secondary"
                        >
                          Edit
                        </Button>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="faqId" value={faq.id} />
                          <Button
                            tone="critical"
                            submit
                          >
                            Delete
                          </Button>
                        </fetcher.Form>
                      </>
                    )}
                  </Card>
                ))
              ) : (
                <p>No FAQs yet.</p>
              )}

              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="id" value={selectedItem.id} />
                <input type="hidden" name="resourceType" value={resourceType} />
                <FormLayout>
                  <TextField
                    label="New Question"
                    name="question"
                    value={question}
                    onChange={setQuestion}
                  />
                  <TextField
                    label="New Answer"
                    name="answer"
                    value={answer}
                    onChange={setAnswer}
                    multiline
                  />
                  <Button submit primary loading={fetcher.state !== "idle"}>
                    Add FAQ
                  </Button>
                </FormLayout>
              </fetcher.Form>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
