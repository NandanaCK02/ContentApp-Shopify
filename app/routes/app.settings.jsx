// routes/app.settings.jsx
import { json } from "@remix-run/node";
import { useLoaderData, Form, useActionData } from "@remix-run/react";

// Loader to provide initial values
export async function loader() {
  // Later you can fetch from Firestore or Shopify metafields
  return json({
    defaultContentType: "faq",
    autoPublish: true,
    blockPosition: "above",
  });
}

// Action to handle form submission
export async function action({ request }) {
  const formData = await request.formData();
  const values = Object.fromEntries(formData);

  // Replace this with logic to save in DB or metafields
  console.log("Saved settings:", values);

  return json({ success: true, saved: values });
}

export default function GeneralSettingsPage() {
  const data = useLoaderData();
  const actionData = useActionData();

  return (
    <div style={{ padding: "2rem", maxWidth: "640px", margin: "0 auto" }}>
      <h1 style={{ fontSize: "24px", fontWeight: "600", marginBottom: "1.5rem" }}>
        App Settings
      </h1>

      <Form method="post">
        {/* Default Content Type */}
        <div style={{ marginBottom: "1.5rem" }}>
          <label style={{ fontWeight: "600", display: "block", marginBottom: "8px" }}>
            Default Content Type
          </label>
          <select
            name="defaultContentType"
            defaultValue={data.defaultContentType}
            style={{ padding: "10px", width: "100%", fontSize: "16px" }}
          >
            <option value="faq">FAQ</option>
            <option value="table">Table</option>
            <option value="bullet">Bullet Points</option>
            <option value="richdescription">Rich Description</option>
            <option value="tabbed">Tabbed</option>
          </select>
        </div>

        {/* Block Position */}
        <div style={{ marginBottom: "1.5rem" }}>
          <label style={{ fontWeight: "600", display: "block", marginBottom: "8px" }}>
            Block Position
          </label>
          <select
            name="blockPosition"
            defaultValue={data.blockPosition}
            style={{ padding: "10px", width: "100%", fontSize: "16px" }}
          >
            <option value="above">Above Product Description</option>
            <option value="below">Below Product Description</option>
          </select>
        </div>

        {/* Auto Publish */}
        <div style={{ marginBottom: "1.5rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "16px" }}>
            <input
              type="checkbox"
              name="autoPublish"
              defaultChecked={data.autoPublish}
            />
            Auto-publish content to storefront
          </label>
        </div>

        {/* Save Button */}
        <button
          type="submit"
          style={{
            padding: "10px 18px",
            backgroundColor: "#7c3aed",
            color: "#fff",
            fontWeight: "600",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          Save Settings
        </button>
      </Form>

      {/* Confirmation Message */}
      {actionData?.success && (
        <p style={{ marginTop: "1rem", color: "green" }}>
          ✅ Settings saved successfully!
        </p>
      )}
    </div>
  );
}
