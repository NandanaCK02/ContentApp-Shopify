import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useNavigation,
  useFetcher,
  useSearchParams,
} from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useRef } from "react";

// ─── LOADER ────────────────────────────────────────────
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ metafields: null, productId: null, selectedProductTitle: null });
  }

  const metafieldsQuery = `
    query getProductMetafields($id: ID!) {
      product(id: $id) {
        title
        features: metafield(namespace: "custom", key: "features") {
          value
        }
        specifications: metafield(namespace: "custom", key: "specifications") {
          value
        }
      }
    }
  `;
  const response = await admin.graphql(metafieldsQuery, {
    variables: { id: productId },
  });
  const data = await response.json();
  const product = data?.data?.product;

  return json({
    productId,
    selectedProductTitle: product?.title || "",
    metafields: {
      features: product?.features?.value || "",
      specifications: product?.specifications?.value || "",
    },
  });
}

// ─── ACTION ────────────────────────────────────────────
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const features = formData.get("features") || "";
  const specifications = formData.get("specifications") || "";

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
      { namespace: "custom", key: "features", type: "single_line_text_field", value: features },
      { namespace: "custom", key: "specifications", type: "single_line_text_field", value: specifications },
    ],
  };

  const response = await admin.graphql(mutation, { variables: { input } });
  const result = await response.json();

  if (result.data.productUpdate.userErrors.length > 0) {
    return json({ error: result.data.productUpdate.userErrors[0].message }, { status: 400 });
  }

  return redirect(`/app/content/tabbed?productId=${encodeURIComponent(productId)}&saved=1`);
}

// ─── COMPONENT ─────────────────────────────────────────
export default function ContentTabbedPage() {
  const { productId, selectedProductTitle, metafields } = useLoaderData();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const formRef = useRef(null);
  const saved = searchParams.get("saved") === "1";

  if (!productId) {
    return (
      <div style={{ color: "#6b7280", fontSize: 18 }}>
        Select a product to edit tabbed content.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <h2 style={{ fontSize: "1rem", fontWeight: 500, marginBottom: 24 }}>
        Tabbed Content
      </h2>

      <fetcher.Form method="post" ref={formRef}>
        <input type="hidden" name="productId" value={productId} />

        <div
          style={{
            background: "#fff",
            borderRadius: 10,
            boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            padding: 28,
            marginBottom: 28,
          }}
        >
          <h3 style={{ fontSize: 18, fontWeight: 500, marginBottom: 8 }}>
            {selectedProductTitle}
          </h3>

          <div style={{ marginBottom: 28 }}>
            <label style={{ fontWeight: 600 }}>Features</label>
            <textarea
              name="features"
              defaultValue={metafields.features}
              rows={4}
              style={{
                width: "100%",
                marginTop: 10,
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                padding: 12,
                fontSize: 16,
                resize: "vertical",
              }}
            />
          </div>

          <div>
            <label style={{ fontWeight: 600 }}>Specifications</label>
            <textarea
              name="specifications"
              defaultValue={metafields.specifications}
              rows={4}
              style={{
                width: "100%",
                marginTop: 10,
                borderRadius: 8,
                border: "1px solid #e5e7eb",
                padding: 12,
                fontSize: 16,
                resize: "vertical",
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          <button
            type="submit"
            disabled={navigation.state === "submitting" || fetcher.state === "submitting"}
            style={{
              background: "#a78bfa",
              color: "#fff",
              fontWeight: 600,
              border: "none",
              borderRadius: 8,
              padding: "12px 28px",
              fontSize: 16,
              cursor: "pointer",
              opacity: navigation.state === "submitting" || fetcher.state === "submitting" ? 0.7 : 1,
            }}
          >
            {navigation.state === "submitting" || fetcher.state === "submitting"
              ? "Saving..."
              : "Save Changes"}
          </button>

          {saved && (
            <span style={{ color: "#22c55e", fontWeight: 600 }}>Saved!</span>
          )}
        </div>
      </fetcher.Form>
    </div>
  );
}
