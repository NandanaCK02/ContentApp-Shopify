import { json, redirect } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useRef, useEffect, useState } from "react";
import { authenticate } from "../shopify.server";

// ─── LOADER ───
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  let productTitle = "";
  let richDescription = "";

  if (productId) {
    const query = `
      query getProductRichDescription($id: ID!) {
        product(id: $id) {
          title
          richDescription: metafield(namespace: "custom", key: "rich_description") {
            value
          }
        }
      }
    `;
    const res = await admin.graphql(query, { variables: { id: productId } });
    const jsonRes = await res.json();

    productTitle = jsonRes?.data?.product?.title || "";
    richDescription = jsonRes?.data?.product?.richDescription?.value || "";
  }

  return json({ productId, productTitle, richDescription });
}

// ─── ACTION ───
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const content = formData.get("description");

  const mutation = `
    mutation UpdateProductRichDescription($input: ProductInput!) {
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
        key: "rich_description",
        type: "multi_line_text_field",
        value: content,
      },
    ],
  };

  const result = await admin.graphql(mutation, { variables: { input } });
  const jsonRes = await result.json();

  if (jsonRes?.data?.productUpdate?.userErrors?.length > 0) {
    return json({ error: jsonRes.data.productUpdate.userErrors[0].message }, { status: 400 });
  }

  return redirect(`/app/content/richdescription?productId=${encodeURIComponent(productId)}&saved=1`);
}

// ─── COMPONENT ───
export default function RichDescriptionPage() {
  const { productId, productTitle, richDescription } = useLoaderData();
  const fetcher = useFetcher();
  const editorRef = useRef();
  const formRef = useRef();
  const [htmlContent, setHtmlContent] = useState(richDescription);
  const [isEmpty, setIsEmpty] = useState(!richDescription);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = richDescription || "";
      setIsEmpty(!richDescription || richDescription.trim() === "");
    }
  }, [richDescription]);

  const handleInput = () => {
    const content = editorRef.current.innerHTML;
    setHtmlContent(content);
    setIsEmpty(editorRef.current.innerText.trim() === "");
  };

  const formatText = (command) => {
    document.execCommand(command, false, null);
    editorRef.current.focus();
  };

  const insertLink = () => {
    const url = prompt("Enter URL:");
    if (url) document.execCommand("createLink", false, url);
  };

  const insertImage = () => {
    const imageUrl = prompt("Enter image URL:");
    if (imageUrl) document.execCommand("insertImage", false, imageUrl);
  };

  const handleSave = () => {
    setHtmlContent(editorRef.current.innerHTML);
    formRef.current.requestSubmit();
  };

  return (
    <div style={{ maxWidth: 800, margin: "2rem auto", padding: "1rem" }}>
      <h2 style={{ fontSize: "1.2rem", fontWeight: "600", marginBottom: "1rem" }}>
        Rich Description : {productTitle || "Unknown Product"}
      </h2>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={() => formatText("bold")} style={btnStyle}>Bold</button>
        <button onClick={() => formatText("italic")} style={btnStyle}>Italic</button>
        <button onClick={insertLink} style={btnStyle}>Link</button>
        <button onClick={insertImage} style={btnStyle}>Image</button>
      </div>

      <div style={{ position: "relative" }}>
        {/* ✅ Placeholder */}
        {isEmpty && (
          <div style={{
            position: "absolute",
            top: "1rem",
            left: "1rem",
            color: "#9ca3af",
            pointerEvents: "none",
            fontSize: "16px"
          }}>
            Write detailed product description here…
          </div>
        )}

        {/* ✅ Editable Area */}
        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          style={{
            minHeight: "250px",
            border: "1px solid #e5e7eb",
            padding: "1rem",
            borderRadius: "8px",
            fontSize: "16px",
            outline: "none",
            background: "#fff"
          }}
        />
      </div>

      <fetcher.Form method="post" ref={formRef}>
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="description" value={htmlContent} />
      </fetcher.Form>

      <button
        onClick={handleSave}
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
        {fetcher.state === "submitting" ? "Saving..." : "Save Description"}
      </button>
    </div>
  );
}

const btnStyle = {
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  background: "#f9fafb",
  cursor: "pointer",
  fontWeight: "500"
};
