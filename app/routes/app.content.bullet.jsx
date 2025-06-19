import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";

// ─── LOADER ────────────────────────────────────────────
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  // Ensure metafield definition exists
  const checkDefinitionQuery = `
    query {
      metafieldDefinitions(first: 1, namespace: "custom", key: "bullet_points", ownerType: PRODUCT) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;
  const checkRes = await admin.graphql(checkDefinitionQuery);
  const checkJson = await checkRes.json();

  if (checkJson?.data?.metafieldDefinitions?.edges.length === 0) {
    const createDefinitionMutation = `
      mutation {
        metafieldDefinitionCreate(definition: {
          name: "Bullet Points",
          namespace: "custom",
          key: "bullet_points",
          type: "list.single_line_text_field",
          ownerType: PRODUCT
        }) {
          createdDefinition {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
    await admin.graphql(createDefinitionMutation);
  }

  let bulletPoints = [];
  let selectedProductTitle = "";

  if (productId) {
    const query = `
      query getProductMetafields($id: ID!) {
        product(id: $id) {
          title
          bulletPoints: metafield(namespace: "custom", key: "bullet_points") {
            value
          }
        }
      }
    `;
    const response = await admin.graphql(query, {
      variables: { id: productId },
    });
    const result = await response.json();
    const product = result?.data?.product;

    selectedProductTitle = product?.title || "";

    try {
      const raw = product?.bulletPoints?.value || "[]";
      bulletPoints = JSON.parse(raw); // ✅ Properly parse JSON list
    } catch {
      bulletPoints = [];
    }
  }

  return json({ bulletPoints, productId, selectedProductTitle });
}

// ─── ACTION ────────────────────────────────────────────
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const points = formData.getAll("points").filter(Boolean);

  const mutation = `
    mutation UpdateProductMetafields($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const input = {
    id: productId,
    metafields: [
      {
        namespace: "custom",
        key: "bullet_points",
        type: "list.single_line_text_field",
        value: JSON.stringify(points), // ✅ Save as valid JSON list
      },
    ],
  };

  const result = await admin.graphql(mutation, { variables: { input } });
  const jsonRes = await result.json();

  if (jsonRes?.data?.productUpdate?.userErrors?.length > 0) {
    return json({ error: jsonRes.data.productUpdate.userErrors[0].message }, { status: 400 });
  }

  return redirect(`/app/content/bullet?productId=${encodeURIComponent(productId)}&saved=1`);
}

// ─── COMPONENT ─────────────────────────────────────────
export default function BulletPointsPage() {
  const { bulletPoints, productId, selectedProductTitle } = useLoaderData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const formRef = useRef(null);

  const [points, setPoints] = useState(bulletPoints);
  const [newPoint, setNewPoint] = useState("");

  const handleAdd = () => {
    if (newPoint.trim()) {
      setPoints([...points, newPoint.trim()]);
      setNewPoint("");
    }
  };

  const handleRemove = (index) => {
    setPoints(points.filter((_, i) => i !== index));
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.get("saved") === "1") {
        setTimeout(() => {
          url.searchParams.delete("saved");
          window.history.replaceState({}, "", url.toString());
        }, 3000);
      }
    }
  }, []);

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ fontSize: "1.25rem", fontWeight: "600" }}>Bullet Points</h2>
        <button
          onClick={() => formRef.current?.requestSubmit()}
          style={{
            background: "#9333ea",
            color: "#fff",
            padding: "10px 20px",
            fontSize: "15px",
            borderRadius: "8px",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {navigation.state === "submitting" || fetcher.state === "submitting"
            ? "Saving..."
            : "Save Changes"}
        </button>
      </div>

      <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>{selectedProductTitle}</p>

      <fetcher.Form method="post" ref={formRef}>
        <input type="hidden" name="productId" value={productId} />

        {points.map((point, index) => (
          <div key={index} style={{
            background: "#fff",
            padding: "1rem",
            marginBottom: "0.5rem",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}>
            <input
              type="text"
              name="points"
              defaultValue={point}
              style={{
                border: "none",
                outline: "none",
                flexGrow: 1,
                fontSize: "14px",
              }}
            />
            <button
              type="button"
              onClick={() => handleRemove(index)}
              style={{
                color: "#ef4444",
                background: "none",
                border: "none",
                cursor: "pointer",
                fontWeight: 500,
                marginLeft: "1rem"
              }}
            >
              Remove
            </button>
          </div>
        ))}

        <div style={{
          marginTop: "1rem",
          border: "2px dashed #e5e7eb",
          padding: "1rem",
          borderRadius: "8px",
          background: "#f9fafb"
        }}>
          <input
            type="text"
            placeholder="Add Bullet Point"
            value={newPoint}
            onChange={(e) => setNewPoint(e.target.value)}
            style={{
              width: "90%",
              padding: "10px",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              marginBottom: "0.5rem"
            }}
          />
          <button
            type="button"
            onClick={handleAdd}
            style={{
              display: "inline-block",
              padding: "8px 16px",
              backgroundColor: "#4f46e5",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            + Add Bullet Point
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}
