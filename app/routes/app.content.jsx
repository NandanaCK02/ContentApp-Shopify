// routes/app.content.jsx
import { json } from "@remix-run/node";
import { Outlet, useLoaderData, useLocation, useNavigate, useSearchParams, Link } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { useEffect, useState } from "react";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const query = `
    query {
      products(first: 50) {
        edges {
          node {
            id
            title
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const result = await response.json();

  const products = result?.data?.products?.edges.map(edge => ({
    id: edge.node.id,
    title: edge.node.title,
  })) || [];

  return json({ products });
}

const contentLinks = [
  { to: "/app/content/tabbed", label: "Tabbed Content" },
  { to: "/app/content/bullet", label: "Bullet Points" },
  { to: "/app/content/table", label: "Tables" },
  { to: "/app/content/richdescription", label: "Rich Description" },

  { to: "/app/content/faq", label: "FAQ Section" },
];

export default function ContentBuilderLayout() {
  const { products } = useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const selectedProductId = searchParams.get("productId") || "";

  function handleProductChange(e) {
    const productId = e.target.value;
    navigate(`${location.pathname}?productId=${encodeURIComponent(productId)}`);
  }

  return (
    <div style={{ display: "flex", height: "100vh", backgroundColor: "#f9fafb" }}>
      {/* Left Sidebar */}
      <aside
        style={{
          width: "280px",
          backgroundColor: "#fffef2",
          borderRight: "1px solid #e5e7eb",
          padding: "1.5rem",
        }}
      >
        {/* Product Selector (Common Search Bar) */}
        <div style={{ marginBottom: "2rem" }}>
          <label style={{ fontWeight: "600", display: "block", marginBottom: "8px" }}>Select Product</label>
          <select
            value={selectedProductId}
            onChange={handleProductChange}
            style={{
              width: "100%",
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid #ccc",
              fontSize: "14px",
            }}
          >
            <option value="">-- Select Product --</option>
            {products.map(p => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>

        {/* Content Navigation */}
        <h2 style={{ fontSize: "18px", fontWeight: "600", marginBottom: "1.2rem" }}>Content Types</h2>
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {contentLinks.map(link => {
            const isActive = location.pathname === link.to;
            return (
              <Link
                key={link.to}
                to={`${link.to}?productId=${encodeURIComponent(selectedProductId)}`}
                style={{
                  padding: "10px 14px",
                  borderRadius: "8px",
                  backgroundColor: isActive ? "#7c3aed" : "transparent",
                  color: isActive ? "#fff" : "#111827",
                  fontWeight: isActive ? "600" : "500",
                  border: isActive ? "1px solid #7c3aed" : "1px solid transparent",
                  textDecoration: "none",
                }}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Right Side: Content Editor */}
      <main style={{ flex: 1, padding: "2rem", overflowY: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
