import * as remixNode from "@remix-run/node";
import {
  useLoaderData,
  useSearchParams,
  useFetcher,
  Form,
} from "@remix-run/react";
import {
  Page,
  Layout,
  TextField,
  Tabs,
  Card,
  Thumbnail,
  Text,
  Banner,
} from "@shopify/polaris";
import { useCallback, useState, useEffect } from "react";
import { authenticate } from "../shopify.server";

const {
  json,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} = remixNode;

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
      if (typeParam === "DOCUMENT") return file.mimeType || file.originalFileSize;
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

export const action = async ({ request }) => {
  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 10_000_000 });
  const formData = await unstable_parseMultipartFormData(request, uploadHandler);
  const file = formData.get("file");

  if (!file || typeof file !== "object") {
    return json({ success: false, error: "No file uploaded." }, { status: 400 });
  }

  const { admin } = await authenticate.admin(request);

  const contentType = "IMAGE";
  const resource = "IMAGE";

  const stagedUploadRes = await admin.graphql(`
    mutation generateStagedUploads($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      input: [{
        filename: file.name,
        mimeType: file.type,
        resource,
        fileSize: file.size.toString(),
      }]
    }
  });

  const stagedData = await stagedUploadRes.json();
  const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];

  if (!target) {
    return json({ success: false, error: "Failed to get staged upload target." });
  }

  const uploadBody = new FormData();
  target.parameters.forEach(param => uploadBody.append(param.name, param.value));
  uploadBody.append("file", file, file.name);

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: uploadBody,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error("S3 upload failed:", errText);
    return json({ success: false, error: "S3 upload failed." });
  }

  const fileCreateRes = await admin.graphql(`
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      files: [{
        alt: file.name,
        contentType,
        originalSource: target.resourceUrl,
      }]
    }
  });

  const result = await fileCreateRes.json();
  console.log("File Create Result:", result);

  if (result?.data?.fileCreate?.userErrors?.length) {
    const errorMsg = result.data.fileCreate.userErrors.map(err => err.message).join(", ");
    console.error("File creation error:", errorMsg);
    return json({ success: false, error: errorMsg });
  }

  return json({ success: true });
};

export default function MediaPage() {
  const { files, query, type } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (fetcher.data?.success) {
      setShowSuccess(true);
    }
    if (fetcher.data?.error) {
      console.error("Upload error:", fetcher.data.error);
    }
  }, [fetcher.data]);

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
    }, [searchParams, setSearchParams]);

  const handleSearchChange = (val) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("query", val);
    newParams.set("type", type);
    setSearchParams(newParams);
  };

  return (
    <Page title="Media Library">
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <fetcher.Form method="post" encType="multipart/form-data">
              <Text variant="headingMd">Upload File</Text>
              <input
                type="file"
                name="file"
                required
                style={{ marginTop: 10, marginBottom: 10, padding: 10, width: "100%", height: 45 }}
              />
              <button
                type="submit"
                style={{
                  backgroundColor: "#008060",
                  color: "white",
                  padding: "10px 20px",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer"
                }}
              >Upload</button>
            </fetcher.Form>
            {showSuccess && (
              <Banner
                status="success"
                title="File uploaded successfully"
                onDismiss={() => setShowSuccess(false)}
              />
            )}
          </Card>

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
            </div>
          </Form>

          <Tabs
            tabs={tabs}
            selected={tabs.findIndex((t) => t.id === type)}
            onSelect={(index) => handleTabChange(tabs[index].id)}
          />

          <div style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "1.5rem",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}>
            {files.length === 0 ? (
              <Text>No files found.</Text>
            ) : (
              files.map((node) => {
                const previewUrl = node.preview?.image?.url;
                if (node.image?.url) return (
                  <Card key={node.id} sectioned>
                    <Thumbnail source={node.image.url} alt={node.alt || "Image"} size="large" />
                    <Text variant="bodyMd" fontWeight="medium">{node.alt || "Untitled Image"}</Text>
                  </Card>
                );
                if (node.sources?.[0]?.url) return (
                  <Card key={node.id} sectioned>
                    <Text variant="bodyMd" fontWeight="medium">🎬 Video</Text>
                    <Text size="small">{node.sources[0].url}</Text>
                  </Card>
                );
                if (node.mimeType || node.originalFileSize) return (
                  <Card key={node.id} sectioned>
                    <Text variant="bodyMd" fontWeight="medium">📄 Document</Text>
                    <Text size="small">Type: {node.mimeType}</Text>
                    <Text size="small">Size: {Math.round((node.originalFileSize || 0) / 1024)} KB</Text>
                  </Card>
                );
                if (previewUrl) return (
                  <Card key={node.id} sectioned>
                    <Thumbnail source={previewUrl} alt="Preview" size="large" />
                    <Text variant="bodyMd">{node.alt || "Untitled File"}</Text>
                  </Card>
                );
                return null;
              })
            )}
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
