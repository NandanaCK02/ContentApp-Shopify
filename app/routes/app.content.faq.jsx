import { json, redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  ResourceList,
  ResourceItem,
  TextField,
  Button,
  FormLayout,
} from "@shopify/polaris";
import { useState, useEffect } from "react";
import prisma from "../db.server";

// ─── LOADER ───
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  // Fetch products from Shopify
  const productQuery = `query {
    products(first: 100) {
      edges {
        node {
          id
          title
        }
      }
    }
  }`;

  const productRes = await admin.graphql(productQuery);
  const productData = await productRes.json();

  const products = productData.data.products.edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
  }));

  let faqs;
  try {
    faqs = await prisma.faq.findMany();
  } catch (error) {
    console.error("Error fetching FAQs:", error);
    faqs = [];
  }

  return json({ products, faqs });
}

// ─── ACTION ───
export async function action({ request }) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    await prisma.faq.create({
      data: {
        question: formData.get("question"),
        answer: formData.get("answer"),
        resourceId: formData.get("id"),
        resourceType: "products",
      },
    });
    return redirect("/app/faq");
  }

  if (intent === "update") {
    await prisma.faq.update({
      where: { id: formData.get("faqId") },
      data: {
        question: formData.get("question"),
        answer: formData.get("answer"),
      },
    });
    return redirect("/app/faq");
  }

  if (intent === "delete") {
    await prisma.faq.delete({
      where: { id: formData.get("faqId") },
    });
    return redirect("/app/faq");
  }

  return redirect("/app/faq");
}

// ─── FRONTEND ───
export default function FAQManagement() {
  const { products, faqs } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productSearch, setProductSearch] = useState("");

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [editingFaqId, setEditingFaqId] = useState(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");

  const filteredProducts = products.filter((product) =>
    product.title.toLowerCase().includes(productSearch.toLowerCase())
  );

  const filteredFaqs = faqs.filter(
    (faq) =>
      faq.resourceId === selectedProduct?.id &&
      faq.resourceType === "products"
  );

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setQuestion("");
      setAnswer("");
      setEditingFaqId(null);
      setEditQuestion("");
      setEditAnswer("");
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Page title="FAQ Manager">
      {!selectedProduct ? (
        <Card title="Select a Product" sectioned>
          {/* Search Field */}
          <TextField
            label="Search Products"
            value={productSearch}
            onChange={setProductSearch}
            placeholder="Type product name..."
            clearButton
            onClearButtonClick={() => setProductSearch("")}
          />

          {/* Product List */}
          <ResourceList
            items={filteredProducts}
            renderItem={(product) => (
              <ResourceItem
                id={product.id}
                accessibilityLabel={`Select ${product.title}`}
                onClick={() => setSelectedProduct(product)}
              >
                <h3>{product.title}</h3>
              </ResourceItem>
            )}
          />
        </Card>
      ) : (
        <>
          <Card title={`FAQs for Product: ${selectedProduct.title}`} sectioned>
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
                        <Button onClick={() => setEditingFaqId(null)} tone="secondary">Cancel</Button>
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
                        <Button tone="critical" submit>Delete</Button>
                      </fetcher.Form>
                    </>
                  )}
                </Card>
              ))
            ) : (
              <p>No FAQs yet for this product.</p>
            )}

            {/* Create New FAQ */}
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="id" value={selectedProduct.id} />
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

            {/* Change Product */}
            <Button
              onClick={() => {
                setSelectedProduct(null);
                setProductSearch("");
              }}
              tone="secondary"
              style={{ marginTop: "1rem" }}
            >
              Change Product
            </Button>
          </Card>
        </>
      )}
    </Page>
  );
}
