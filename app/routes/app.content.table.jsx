import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";

// ─── LOADER ───
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  let productTitle = "";
  let featureTable = [];

  if (productId) {
    const query = `
      query getProductFeatureTable($id: ID!) {
        product(id: $id) {
          title
          featureTable: metafield(namespace: "custom", key: "feature_table") {
            value
          }
        }
      }
    `;

    const res = await admin.graphql(query, { variables: { id: productId } });
    const jsonRes = await res.json();

    productTitle = jsonRes?.data?.product?.title || "";

    try {
      featureTable = JSON.parse(jsonRes?.data?.product?.featureTable?.value || "[]");
    } catch {
      featureTable = [];
    }
  }

  return json({ productId, productTitle, featureTable });
}

// ─── ACTION ───
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");

  const rows = [];
  const rowCount = parseInt(formData.get("rowCount"));

  for (let i = 0; i < rowCount; i++) {
    const name = formData.get(`rowName_${i}`);
    const value = formData.get(`rowValue_${i}`);
    if (name || value) {
      rows.push({ name, value });
    }
  }

  const mutation = `
    mutation UpdateProductFeatureTable($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;

  const input = {
    id: productId,
    metafields: [
      {
        namespace: "custom",
        key: "feature_table",
        type: "json",
        value: JSON.stringify(rows),
      },
    ],
  };

  const result = await admin.graphql(mutation, { variables: { input } });
  const jsonRes = await result.json();

  if (jsonRes?.data?.productUpdate?.userErrors?.length > 0) {
    return json({ error: jsonRes.data.productUpdate.userErrors[0].message }, { status: 400 });
  }

  return redirect(`/app/content/table?productId=${encodeURIComponent(productId)}&saved=1`);
}

// ─── FRONTEND COMPONENT ───
export default function TableDemoPage() {
  const { productId, productTitle, featureTable } = useLoaderData();
  const fetcher = useFetcher();
  const formRef = useRef();

  const [rows, setRows] = useState(featureTable.length > 0 ? featureTable : [{ name: "", value: "" }]);

  const handleAddRow = () => {
    setRows([...rows, { name: "", value: "" }]);
  };

  const handleChange = (index, field, value) => {
    const updated = [...rows];
    updated[index][field] = value;
    setRows(updated);
  };

  const handleRemove = (index) => {
    setRows(rows.filter((_, i) => i !== index));
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "1rem" }}>
      <h2 style={{ fontSize: "1.2rem", fontWeight: "600", marginBottom: "1rem" }}>
        Feature Table : {productTitle || "Unknown Product"}
      </h2>

      <fetcher.Form method="post" ref={formRef}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="rowCount" value={rows.length} />

        <table style={{
          width: "100%",
          borderCollapse: "collapse",
          marginBottom: "1rem",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: "8px",
          overflow: "hidden"
        }}>
          <thead style={{ backgroundColor: "#f3f4f6" }}>
            <tr>
              <th style={thStyle}>Feature Name</th>
              <th style={thStyle}>Feature Value</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td style={tdStyle}>
                  <input
                    type="text"
                    name={`rowName_${index}`}
                    value={row.name}
                    onChange={(e) => handleChange(index, "name", e.target.value)}
                    placeholder="Name"
                    style={inputStyle}
                  />
                </td>
                <td style={tdStyle}>
                  <input
                    type="text"
                    name={`rowValue_${index}`}
                    value={row.value}
                    onChange={(e) => handleChange(index, "value", e.target.value)}
                    placeholder="Value"
                    style={inputStyle}
                  />
                </td>
                <td style={tdStyle}>
                  <button
                    type="button"
                    onClick={() => handleRemove(index)}
                    style={{
                      background: "#ef4444",
                      color: "#fff",
                      border: "none",
                      padding: "6px 12px",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontWeight: "500"
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          type="button"
          onClick={handleAddRow}
          style={{
            backgroundColor: "#4f46e5",
            color: "#fff",
            border: "none",
            borderRadius: "6px",
            padding: "10px 20px",
            fontWeight: "600",
            cursor: "pointer"
          }}
        >
          + Add Row
        </button>

        <br />

        <button
          type="submit"
          style={{
            marginTop: "1rem",
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
          {fetcher.state === "submitting" ? "Saving..." : "Save Table"}
        </button>
      </fetcher.Form>
    </div>
  );
}

const thStyle = {
  padding: "12px",
  textAlign: "left",
  fontSize: "14px",
  color: "#374151",
  borderBottom: "1px solid #e5e7eb"
};

const tdStyle = {
  padding: "10px",
  borderBottom: "1px solid #f3f4f6"
};

const inputStyle = {
  width: "100%",
  padding: "8px",
  borderRadius: "6px",
  border: "1px solid #d1d5db",
  fontSize: "14px"
};
