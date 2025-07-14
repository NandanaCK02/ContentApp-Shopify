import * as remixNode from "@remix-run/node";
import {
  useLoaderData,
  useSearchParams,
  Form,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  TextField,
  Tabs,
  Card,
  Text,
  Button,
} from "@shopify/polaris";
import { useCallback, useRef } from "react";
import { authenticate } from "../shopify.server";

const { json } = remixNode;

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const queryParam = url.searchParams.get("query") || "";
  const typeParam = url.searchParams.get("type") || "ALL";
  const { admin } = await authenticate.admin(request);

  const gql = `
    query FetchFiles {
      files(first: 50) {
        edges {
          node {
            id
            alt
            createdAt
            fileStatus
            preview {
              image {
                url
              }
            }
            ... on MediaImage {
              image {
                url
              }
            }
            ... on Video {
              sources {
                url
              }
            }
            ... on GenericFile {
              originalFileSize
              mimeType
              url
            }
          }
        }
      }
    }
  `;

  try {
    const response = await admin.graphql(gql);
    const data = await response.json();
    let files = data?.data?.files?.edges?.map((edge) => edge.node) || [];

    files = files.filter((file) => {
      if (typeParam === "ALL") return true;
      if (typeParam === "IMAGE") return file.image?.url;
      if (typeParam === "VIDEO") return file.sources?.[0]?.url;
      if (typeParam === "DOCUMENT") {
        // Consider as document if it's a GenericFile with a mimeType (not image/video)
        return (
          file.mimeType &&
          !file.image?.url &&
          !file.sources?.[0]?.url
        );
      }
      return true;
    });

    if (queryParam) {
      const q = queryParam.toLowerCase();
      files = files.filter((file) => (file.alt || "").toLowerCase().includes(q));
    }

    return json({ files, query: queryParam, type: typeParam });
  } catch (error) {
    console.error("Error fetching media:", error);
    return json({ files: [], query: queryParam, type: typeParam });
  }
};

export default function MediaPage() {
  const { files, query, type } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const fileInputRef = useRef(null);

  const tabs = [
    { id: "ALL", content: "All Files" },
    { id: "IMAGE", content: "Images" },
    { id: "VIDEO", content: "Videos" },
    { id: "DOCUMENT", content: "Documents" },
  ];

  const handleTabChange = useCallback(
    (selectedTabId) => {
      const newParams = new URLSearchParams(searchParams);
      newParams.set("type", selectedTabId);
      setSearchParams(newParams);
    },
    [searchParams, setSearchParams]
  );

  const handleSearchChange = (val) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("query", val);
    newParams.set("type", type);
    setSearchParams(newParams);
  };

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (file) {
      const formData = new FormData();
      formData.append("file", file);
      fetcher.submit(formData, {
        method: "post",
        encType: "multipart/form-data",
        action: "/app/upload",
      });
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleDelete = (fileId) => {
    const formData = new FormData();
    formData.append("intent", "deleteFile");
    formData.append("fileId", fileId);
    fetcher.submit(formData, {
      method: "post",
      action: "/app/upload",
    });
  };

  return (
    <Page title="Media Library">
      <Layout>
        <Layout.Section>
          <Form method="get">
            <div style={{ display: "flex", gap: "1rem", margin: "1.5rem 0" }}>
              <TextField
                labelHidden
                label="Search"
                name="query"
                value={query}
                onChange={handleSearchChange}
                placeholder="Search files by name..."
              />
              <Button onClick={handleUploadClick}> Upload File </Button>
              <input
                type="file"
                accept="*/*"
                style={{ display: "none" }}
                ref={fileInputRef}
                onChange={handleFileChange}
              />
            </div>
          </Form>

          <Tabs
            tabs={tabs}
            selected={tabs.findIndex((t) => t.id === type)}
            onSelect={(index) => handleTabChange(tabs[index].id)}
          />

          <div
            style={{
              marginTop: "1.5rem",
              display: "grid",
              gap: "1rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            }}
          >
            {files.length === 0 ? (
              <Text>No files found.</Text>
            ) : (
              files.map((node) => {
                const isImage = node.image?.url;
                const isVideo = node.sources?.[0]?.url;
                const isDocument =
                  node.mimeType &&
                  !isImage &&
                  !isVideo;

                return (
                  <Card key={node.id} sectioned>
                    <div style={{ padding: "0.5rem" }}>
                      {isImage && (
                        <img
                          src={node.image.url}
                          alt={node.alt || "Image"}
                          style={{
                            width: "100%",
                            height: "auto",
                            borderRadius: "8px",
                            marginBottom: "0.5rem",
                          }}
                        />
                      )}
                      {isVideo && (
                        <div style={{ marginBottom: "0.5rem" }}>
                          <video
                            src={node.sources[0].url}
                            controls
                            style={{
                              width: "100%",
                              borderRadius: "8px",
                              background: "#000",
                            }}
                          />
                        </div>
                      )}
                      {isDocument && (
                        <div style={{ marginBottom: "0.5rem", textAlign: "center" }}>
                          <span role="img" aria-label="Document" style={{ fontSize: 40 }}>
                            📄
                          </span>
                          <br />
                          <a
                            href={node.url || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 12, wordBreak: "break-all" }}
                          >
                            Open
                          </a>
                        </div>
                      )}
                      <Text variant="bodySm" fontWeight="medium" truncate>
                        {node.alt || "Untitled File"}
                      </Text>
                      <Button
                        size="slim"
                        destructive
                        onClick={() => handleDelete(node.id)}
                        style={{ marginTop: "0.5rem" }}
                      >
                        Delete
                      </Button>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
