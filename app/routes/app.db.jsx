import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import prisma from "../db.server";
//import { authenticate } from "../shopify.server";


export const loader = async () => {
  const tests = await prisma.test.findMany({
    orderBy: { id: "desc" },
  });
  return json({ tests });
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const name = formData.get("name")?.trim();
  const email = formData.get("email")?.trim();

  if (!name || !email) {
    return json(
      { success: false, message: "Both name and email are required." },
      { status: 400 }
    );
  }

  try {
    await prisma.test.create({
      data: { name, email },
    });
    return json({ success: true });
  } catch (error) {
    console.error("Error creating test:", error);
    return json(
      { success: false, message: "Database error: " + error.message },
      { status: 500 }
    );
  }
};

export default function AppDB() {
  const { tests } = useLoaderData();
  const fetcher = useFetcher();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  // Clear form after successful submit
  useEffect(() => {
    if (fetcher.type === "done" && fetcher.data?.success) {
      setName("");
      setEmail("");
    }
  }, [fetcher.type, fetcher.data]);

  return (
    <div style={{ padding: 20, fontFamily: "Arial, sans-serif", maxWidth: 600, margin: "auto" }}>
      <h1>Test Entries</h1>

      <fetcher.Form method="post" style={{ marginBottom: 20 }}>
        <div style={{ marginBottom: 10 }}>
          <label>
            Name: <br />
            <input
              name="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ width: "100%", padding: 8 }}
              autoComplete="off"
            />
          </label>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label>
            Email: <br />
            <input
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: "100%", padding: 8 }}
              autoComplete="off"
            />
          </label>
        </div>
        <button type="submit" disabled={fetcher.state !== "idle"} style={{ padding: "8px 16px" }}>
          {fetcher.state === "submitting" ? "Saving..." : "Add Entry"}
        </button>
        {fetcher.data?.success === false && (
          <p style={{ color: "red", marginTop: 10 }}>{fetcher.data.message}</p>
        )}
      </fetcher.Form>

      <table
        border="1"
        cellPadding="8"
        cellSpacing="0"
        style={{ width: "100%", borderCollapse: "collapse" }}
      >
        <thead style={{ backgroundColor: "#eee" }}>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
            <th>Created At</th>
          </tr>
        </thead>
        <tbody>
          {tests.length === 0 ? (
            <tr>
              <td colSpan="4" style={{ textAlign: "center", padding: 10 }}>
                No records found.
              </td>
            </tr>
          ) : (
            tests.map(({ id, name, email, createdAt }) => (
              <tr key={id}>
                <td>{id}</td>
                <td>{name}</td>
                <td>{email}</td>
                <td>{new Date(createdAt).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
