import { json } from "@remix-run/node";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
import Papa from "papaparse";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Button,
  DropZone,
  Banner,
} from "@shopify/polaris";

/* ---------- Helper functions for metafield update ---------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}

async function getProductIdBySku(admin, sku) {
  const cleanSku = sku.trim();
  const query = `
    {
      productVariants(first: 1, query: "sku:${cleanSku}") {
        edges {
          node {
            product { id }
          }
        }
      }
    }
  `;
  const res = await admin.graphql(query);       // Response object
  const data = await res.json();                // parse JSON
  const edge = data?.data?.productVariants?.edges?.[0];
  return edge ? edge.node.product.id : null;
}

function specsToHtmlTable(specs) {
  if (!specs.length) return "";
  const rows = specs
    .map(
      ({ spec_key, spec_value }) =>
        `<tr><td>${escapeHtml(spec_key)}</td><td>${escapeHtml(spec_value)}</td></tr>`
    )
    .join("");
  return `<table>${rows}</table>`;
}

async function updateProductMetafield(admin, productId, htmlTable) {
  const mutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId: productId,
        namespace: "gentech",
        key: "specification",
        type: "multi_line_text_field",
        value: htmlTable,
      },
    ],
  };
  const res = await admin.graphql(mutation, { variables });
  const data = await res.json();
  if (data?.data?.metafieldsSet?.userErrors?.length) {
    throw new Error(
      data.data.metafieldsSet.userErrors.map((e) => e.message).join(", ")
    );
  }
  return data.data.metafieldsSet.metafields[0];
}

/* ---------- Action ---------- */
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const rawRows = JSON.parse(formData.get("rows") || "[]");
  if (!rawRows.length) {
    return json({ ok: false, error: "No CSV data found" }, { status: 400 });
  }

  let inserted = 0;
  let skipped = 0;
  const dbOps = [];

  // Insert into DB if not exists
  for (const row of rawRows) {
    const sku = (row.sku || "").trim();
    const spec_key = (row.specKey || row.spec_key || "").trim();
    const spec_value = (row.specValue || row.spec_value || "").trim();
    if (!sku || !spec_key || !spec_value) continue;

    const exists = await prisma.specifications.findUnique({
      where: { sku_spec_key_value: { sku, spec_key, spec_value } },
    });

    if (!exists) {
      dbOps.push(
        prisma.specifications.create({ data: { sku, spec_key, spec_value } })
      );
      inserted++;
    } else {
      skipped++;
    }
  }

  if (dbOps.length > 0) await prisma.$transaction(dbOps);

  // Metafield update phase
  const skus = [...new Set(rawRows.map((r) => (r.sku || "").trim()).filter(Boolean))];
  let metafieldUpdated = 0;
  let metafieldErrors = 0;
  const failedSkus = [];

  for (const sku of skus) {
    try {
      const specs = await prisma.specifications.findMany({ where: { sku } });
      if (!specs.length) continue;

      const htmlTable = specsToHtmlTable(specs);
      const productId = await getProductIdBySku(admin, sku);
      if (!productId) {
        metafieldErrors++;
        failedSkus.push(`${sku} (Product not found)`);
        continue;
      }

      await updateProductMetafield(admin, productId, htmlTable);
      metafieldUpdated++;
    } catch (error) {
      metafieldErrors++;
      failedSkus.push(`${sku} (${error.message})`);
      console.error(`❌ Metafield update failed for ${sku}:`, error);
    }
  }

  return json({
    ok: true,
    inserted,
    skipped,
    metafieldUpdated,
    metafieldErrors,
    failedSkus,
  });
}

/* ---------- UI ---------- */
export default function UploadSpecsPage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [previewRows, setPreviewRows] = useState([]);
  const [fileName, setFileName] = useState("");

  const sampleRows = [
    { sku: "DUMMY-001", spec_key: "Color", spec_value: "Red" },
    { sku: "DUMMY-001", spec_key: "Color", spec_value: "Blue" },
    { sku: "DUMMY-002", spec_key: "Material", spec_value: "Steel" },
  ];

  const handleDrop = useCallback((files) => {
    if (files.length === 0) return;
    const file = files[0];
    setFileName(file.name);

    file.text().then((text) => {
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      if (parsed.errors.length) {
        alert("CSV parse error: " + parsed.errors[0].message);
        return;
      }
      setPreviewRows(parsed.data);
    });
  }, []);

  const handleSave = () => {
    const fd = new FormData();
    fd.append("rows", JSON.stringify(previewRows));
    submit(fd, { method: "post" });
  };

  const exportSample = () => {
    const csv = Papa.unparse(sampleRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sample_dummy_data.csv";
    a.click();
  };

  return (
    <Page title="Upload Specifications CSV">
      <Layout>
        {/* Download dummy CSV */}
        <Layout.Section>
          <Card>
            <InlineStack align="end">
              <Button size="slim" onClick={exportSample}>
                Download Dummy CSV
              </Button>
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* File upload */}
        <Layout.Section>
          <Card title="Upload your CSV" sectioned>
            <div style={{ maxWidth: 280, margin: "0 auto" }}>
              <DropZone accept=".csv" type="file" onDrop={handleDrop}>
                {fileName ? (
                  <DropZone.FileUpload actionHint={`Selected: ${fileName}`} />
                ) : (
                  <DropZone.FileUpload actionHint="Select or drop a CSV file" />
                )}
              </DropZone>
            </div>

            {previewRows.length > 0 && (
              <BlockStack gap="400" inlineAlign="end" style={{ marginTop: 16 }}>
                <Button
                  onClick={handleSave}
                  loading={navigation.state === "submitting"}
                  style={{
                    backgroundColor: "#FF6F00",
                    color: "#fff",
                    border: "none",
                  }}
                >
                  Save to DB
                </Button>
              </BlockStack>
            )}
          </Card>
        </Layout.Section>

        {/* Results */}
        {actionData?.ok && (
          <Layout.Section>
            <Banner status="success">
              ✅ Inserted {actionData.inserted}, Skipped {actionData.skipped} exact duplicates.
              <br />
              📌 Metafields updated: {actionData.metafieldUpdated}, Errors: {actionData.metafieldErrors}
              {actionData.failedSkus?.length > 0 && (
                <>
                  <br />
                  ❌ Failed SKUs: {actionData.failedSkus.join(", ")}
                </>
              )}
            </Banner>
          </Layout.Section>
        )}
        {actionData?.error && (
          <Layout.Section>
            <Banner status="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
