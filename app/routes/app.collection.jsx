// app/routes/collections.jsx

import { json, unstable_parseMultipartFormData, unstable_createMemoryUploadHandler } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  LegacyStack,
  Text,
  DropZone,
  DataTable,
  Frame,
  Toast,
  Link,
  List,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback, useEffect } from "react";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useRevalidator } from "@remix-run/react";

// --- Helper functions for validation (defined once at the top) ---
function isValidJson(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch (e) {
    return false;
  }
}

// --- GraphQL Queries and Mutations ---

const GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY = `
  query getCollections($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
        descriptionHtml
        sortOrder
        templateSuffix
        updatedAt
        image { src }
        metafields(first: 250) {
          nodes {
            id
            namespace
            key
            value
            type
          }
        }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
    }
  }
`;

const COLLECTION_MUTATION = `
  mutation collectionMutate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
    collectionCreate(input: $input) {
      collection {
        id
        title
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
          }
        }
      }
      userErrors { field message }
    }
  }
`;


const SET_METAFIELDS_MUTATION = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
        type
      }
      userErrors { field message }
    }
  }
`;

const GET_COLLECTION_TITLES_QUERY = `
  query getCollectionTitles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Collection {
        id
        title
      }
    }
  }
`;

// --- Loader ---

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  if (!session || !admin) {
    throw new Response("Unauthorized", { status: 401 });
  }

  let collections = [];
  let cursor = null;
  let hasNextPage = true;

  // Store key -> { type, namespace } for metafield definitions found in existing collections
  const allMetafieldDefinitions = new Map();

  try {
    while (hasNextPage) {
      const response = await admin.graphql(GET_ALL_COLLECTIONS_WITH_METAFIELDS_QUERY, {
        variables: { cursor },
      });
      const data = await response.json();

      if (data.errors) {
        console.error("GraphQL loader errors (GET_ALL_COLLECTIONS_WITH_METAFIELDS):", JSON.stringify(data.errors, null, 2));
        throw new Error(`Failed to fetch collections: ${data.errors.map(e => e.message).join(", ")}`);
      }

      const result = data.data.collections;

      collections.push(...result.nodes);
      hasNextPage = result.pageInfo.hasNextPage;
      cursor = result.pageInfo.endCursor;

      result.nodes.forEach(collection => {
        collection.metafields.nodes.forEach(mf => {
          if (!allMetafieldDefinitions.has(mf.key)) {
            // Store both type and namespace
            allMetafieldDefinitions.set(mf.key, { type: mf.type, namespace: mf.namespace });
          }
        });
      });
    }

    // Resolve GIDs in metafield values to names for display in the UI and prepare for export
    for (const collection of collections) {
      // Determine collection type (Smart/Manual)
      collection.type = collection.ruleSet ? "Smart" : "Manual";

      // Prepare rules for export/display
      collection.exportedRules = collection.ruleSet?.rules || [];


      for (const metafield of collection.metafields.nodes) {
        // Handle list.collection_reference for display (human-readable titles)
        if (metafield.type === 'list.collection_reference' && typeof metafield.value === 'string') {
          let gids = [];
          try {
            const parsed = JSON.parse(metafield.value);
            if (Array.isArray(parsed)) {
              gids = parsed;
            }
          } catch (e) {
            console.warn(`Metafield '${metafield.key}' has invalid JSON for list.collection_reference: ${metafield.value}`);
            gids = [];
          }

          const validGids = gids.filter(gid => typeof gid === 'string' && gid.startsWith("gid://shopify/Collection/"));

          if (validGids.length > 0) {
            try {
              const response = await admin.graphql(GET_COLLECTION_TITLES_QUERY, {
                variables: { ids: validGids },
              });
              const result = await response.json();

              if (result.errors) {
                console.error("GraphQL loader (GET_COLLECTION_TITLES) errors for metafield GIDs:", JSON.stringify(result.errors, null, 2));
                metafield.displayValue = "Error resolving references.";
                continue;
              }

              const titleMap = {};
              for (const node of result.data.nodes) {
                if (node && node.id && node.title) titleMap[node.id] = node.title;
              }
              metafield.displayValue = validGids.map((gid) => titleMap[gid] || `[Invalid GID: ${gid}]`).join(", ");
            } catch (error) {
              console.error(`Error resolving GIDs for collection ${collection.id}, metafield ${metafield.key}:`, error);
              metafield.displayValue = "Error resolving references.";
            }
          } else {
            metafield.displayValue = "";
          }
        }
        // Handle single collection_reference for display
        else if (metafield.type === 'collection_reference' && typeof metafield.value === 'string' && metafield.value.startsWith("gid://shopify/Collection/")) {
          try {
            const response = await admin.graphql(GET_COLLECTION_TITLES_QUERY, {
              variables: { ids: [metafield.value] },
            });
            const result = await response.json();
            if (!result.errors && result.data?.nodes?.[0]?.title) {
              metafield.displayValue = result.data.nodes[0].title;
            } else {
              metafield.displayValue = `[Invalid GID: ${metafield.value}]`;
            }
          } catch (error) {
            console.error(`Error resolving single GID for collection ${collection.id}, metafield ${metafield.key}:`, error);
            metafield.displayValue = "Error resolving reference.";
          }
        } else {
          metafield.displayValue = metafield.value; // For all other types, display the raw value
        }
      }
    }
  } catch (error) {
    console.error("Error in collections loader:", error);
    return json({ collections: [], error: error.message || "Failed to load collections." }, { status: 500 });
  }

  return json({ collections, metafieldDefinitions: Object.fromEntries(allMetafieldDefinitions) });
};

// --- Action (Import) ---

function convertValueForShopifyType(value, type) {
  // If the value is truly empty or undefined, return null to signify "no value" or deletion
  if (value === null || value === undefined || (typeof value === 'string' && String(value).trim() === "")) {
    // For reference types, rich_text, and JSON, if empty, send null to clear.
    // For boolean, default to false if explicitly empty/null (as per Shopify's typical behavior for new/empty).
    // For other types, null effectively clears them if they exist.
    if (type.endsWith('_reference') || type.startsWith('list.') || type === 'rich_text' || type === 'json') {
      return null;
    }
    if (type === 'boolean') {
      return false; // Default to false if no value is provided, rather than null which might not clear the field.
    }
    // For other string/number fields, an empty string might be desired, but if `value` is truly empty, null is safer to clear.
    return null;
  }

  const stringValue = String(value);

  switch (type) {
    case "number_integer":
      const intValue = parseInt(stringValue, 10);
      return isNaN(intValue) ? null : String(intValue);
    case "number_decimal":
      const decimalValue = parseFloat(stringValue);
      return isNaN(decimalValue) ? null : String(decimalValue);
    case "boolean":
      // Handle "Any"/"All" from export, and standard "true"/"false" or "1"/"0"
      if (stringValue.toLowerCase() === "any") return true;
      if (stringValue.toLowerCase() === "all") return false;
      return stringValue.toLowerCase() === "true" || stringValue === "1" || stringValue.toLowerCase() === "yes";
    case "json":
    case "dimension":
    case "volume":
    case "weight":
    case "rating":
      // Value must be a string that represents valid JSON
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        console.warn(`Invalid JSON format for metafield type '${type}': "${stringValue}". Returning null.`);
        return null; // Return null if invalid JSON
      }
    case "rich_text":
      // If it's already valid JSON (likely from a previous export), use it.
      // Otherwise, assume it's plain text and convert to Shopify's rich_text JSON format.
      try {
        JSON.parse(stringValue);
        return stringValue;
      } catch (e) {
        // Fallback for plain text: convert to rich_text JSON format
        return JSON.stringify({
          "blocks": [
            {
              "type": "paragraph",
              "children": [
                { "text": stringValue }
              ]
            }
          ]
        });
      }
    case "date":
      // Excel dates are numbers (days since 1900-01-01). Handle both number and string formats.
      if (typeof value === 'number') {
        const date = new Date(Math.round((value - 25569) * 86400 * 1000)); // Convert Excel serial date to JS Date
        return date.toISOString().split('T')[0]; // Format to YYYY-MM-DD
      }
      // If it's a string, attempt to parse and format
      const dateParse = new Date(stringValue);
      return isNaN(dateParse.getTime()) ? null : dateParse.toISOString().split('T')[0];
    case "date_time":
      // Excel dates are numbers. Handle both number and string formats.
      if (typeof value === 'number') {
        const dateTime = new Date(Math.round((value - 25569) * 86400 * 1000));
        return dateTime.toISOString(); // Full ISO format
      }
      // If it's a string, attempt to parse and format
      const dateTimeParse = new Date(stringValue);
      return isNaN(dateTimeParse.getTime()) ? null : dateTimeParse.toISOString();
    case "url":
      if (!isValidUrl(stringValue)) {
        console.warn(`Invalid URL for metafield type 'url': "${stringValue}". Returning null.`);
        return null; // Return null for invalid URLs
      }
      return stringValue;
    case "collection_reference":
      // Expects a single GID string
      return stringValue.startsWith("gid://shopify/Collection/") ? stringValue : null;
    case "list.collection_reference":
      // Expects a JSON array string of GIDs
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && item.startsWith("gid://shopify/Collection/"))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.collection_reference: "${stringValue}". Returning null.`);
      }
      return null;
    case "file_reference":
    case "image_reference":
      // Expects a single GID string
      return stringValue.startsWith("gid://shopify/File/") || stringValue.startsWith("gid://shopify/MediaImage/") ? stringValue : null;
    case "list.file_reference":
    case "list.image_reference":
      // Expects a JSON array string of GIDs
      try {
        const parsed = JSON.parse(stringValue);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && (item.startsWith("gid://shopify/File/") || item.startsWith("gid://shopify/MediaImage/")))) {
          return JSON.stringify(parsed);
        }
      } catch (e) {
        console.warn(`Invalid JSON or GID format for list.file_reference/image_reference: "${stringValue}". Returning null.`);
      }
      return null;
    default:
      return stringValue; // For generic text fields, return the string value directly
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  if (!session) {
    return json({ success: false, error: "Authentication required.", status: 401 }, { status: 401 });
  }

  const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 50_000_000 }); // 50 MB
  let formData;
  try {
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } catch (error) {
    console.error("Error parsing multipart form data:", error);
    return json({ success: false, error: "Failed to parse file upload. File might be too large or corrupted.", details: error.message }, { status: 400 });
  }

  const file = formData.get("file");

  if (!file || !(file instanceof Blob)) {
    return json({ success: false, error: "No file uploaded or invalid file type. Please upload an Excel (.xlsx) file.", status: 400 }, { status: 400 });
  }

  let workbook;
  let worksheet;
  let headerRowValues;
  const collectionsData = JSON.parse(formData.get("collectionsData"));
  // This map now holds { key: { type, namespace } } for known metafields
  const originalMetafieldDefinitionsMap = collectionsData.metafieldDefinitions || {};

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    worksheet = workbook.worksheets[0];

    if (!worksheet) {
      return json({ success: false, error: "Excel file is empty or invalid format. No worksheet found.", status: 400 });
    }

    headerRowValues = worksheet.getRow(1).values;
    // ExcelJS `values` returns an array where index 0 is null/undefined and actual values start from index 1.
    // Filter out null/undefined values to get actual headers.
    const filteredHeaderRowValues = headerRowValues.filter(h => h !== null && h !== undefined && String(h).trim() !== '');

    // Expected minimal headers
    if (!filteredHeaderRowValues || filteredHeaderRowValues.length < 7) {
      return json({ success: false, error: "Excel file is missing expected header columns (Collection ID, Title, Description, Sort Order, Template Suffix, Collection Type, Smart Collection: Applied Disjunctively).", status: 400 });
    }

  } catch (error) {
    console.error("Error reading Excel file:", error);
    return json({ success: false, error: `Failed to read Excel file: ${error.message}. Ensure it's a valid .xlsx format.`, status: 400 }, { status: 400 });
  }

  let errors = [];
  let processedRowsCount = 0;
  let updatedCollectionsCount = 0;
  let createdCollectionsCount = 0;
  let updatedMetafieldsCount = 0;

  // Identify column indices dynamically for robustness
  const headerMap = new Map(); // Header Name -> Column Index (1-based from ExcelJS)
  headerRowValues.forEach((h, idx) => {
    if (typeof h === 'string' && h.trim() !== '') {
      headerMap.set(h.trim(), idx);
    }
  });

  const getCellVal = (row, header) => {
    const colIndex = headerMap.get(header);
    return colIndex ? row.getCell(colIndex)?.value : undefined;
  };

  for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const id = String(getCellVal(row, "Collection ID") || '').trim();
    const title = String(getCellVal(row, "Title") || '').trim();
    const descriptionHtml = String(getCellVal(row, "Description") || '').trim();
    const sortOrderRaw = getCellVal(row, "Sort Order");
    const templateSuffix = String(getCellVal(row, "Template Suffix") || '').trim() || null;
    const collectionType = String(getCellVal(row, "Collection Type") || '').trim().toLowerCase();
    const appliedDisjunctivelyRaw = getCellVal(row, "Smart Collection: Applied Disjunctively");

    // Skip row if title is empty for new collection
    if (!id && !title) {
      errors.push({ row: rowIndex, message: "Skipping row: Title is empty for new collection, and Collection ID is missing." });
      continue;
    }
    // Validate Collection ID for updates
    if (id && !id.startsWith("gid://shopify/Collection/")) {
      errors.push({
        row: rowIndex,
        message: `Invalid Collection ID in Column 'Collection ID'. Expected format: 'gid://shopify/Collection/12345'. Found: "${id || 'EMPTY'}"`
      });
      continue;
    }

    const collectionInput = {
      title,
      descriptionHtml,
    };

    if (sortOrderRaw) {
      const sortOrder = String(sortOrderRaw).toUpperCase().trim();
      const validSortOrders = ['ALPHA_ASC', 'ALPHA_DESC', 'BEST_SELLING', 'CREATED', 'MANUAL', 'PRICE_ASC', 'PRICE_DESC'];
      if (validSortOrders.includes(sortOrder)) {
        collectionInput.sortOrder = sortOrder;
      } else {
        errors.push({ row: rowIndex, message: `Invalid Sort Order value: "${sortOrderRaw}". Must be one of: ${validSortOrders.join(", ")}. Skipping sortOrder update.` });
      }
    }

    collectionInput.templateSuffix = templateSuffix;

    // --- Smart Collection RuleSet Handling ---
    if (collectionType === 'smart') {
      const rules = [];
      let ruleIndex = 1;
      while (headerMap.has(`Rule ${ruleIndex} - Column`)) {
        const column = String(getCellVal(row, `Rule ${ruleIndex} - Column`) || '').trim();
        const relation = String(getCellVal(row, `Rule ${ruleIndex} - Relation`) || '').trim();
        const condition = getCellVal(row, `Rule ${ruleIndex} - Condition`);

        if (column && relation && condition !== undefined && String(condition).trim() !== '') {
          rules.push({ column, relation, condition: String(condition) });
        } else if (column || relation || (condition !== undefined && String(condition).trim() !== '')) {
          errors.push({
            row: rowIndex,
            message: `Incomplete rule ${ruleIndex} for smart collection. All of 'Column', 'Relation', 'Condition' must be present and non-empty for rule ${ruleIndex}.`
          });
        }
        ruleIndex++;
      }

      if (rules.length > 0) {
        const appliedDisjunctivelyBoolean = String(appliedDisjunctivelyRaw || '').toLowerCase() === 'any';
        collectionInput.ruleSet = {
          appliedDisjunctively: appliedDisjunctivelyBoolean,
          rules: rules,
        };
      } else {
        errors.push({
          row: rowIndex,
          message: `Collection type is 'Smart' but no valid rules were found. Smart collections require at least one rule. This collection will be treated as Manual.`
        });
        collectionInput.ruleSet = null;
      }
    } else {
      collectionInput.ruleSet = null;
    }

    // --- Perform Collection Update or Create ---
    let mutationType = id ? "update" : "create";
    try {
      let mutationResponse;
      let mutationResult;

      if (mutationType === "update") {
        const updateInput = { ...collectionInput, id: id };
        mutationResponse = await admin.graphql(COLLECTION_MUTATION, {
          variables: { input: updateInput },
        });
        mutationResult = await mutationResponse.json();

        if (mutationResult.data?.collectionUpdate?.userErrors?.length > 0) {
          errors.push({
            row: rowIndex,
            message: `Collection update errors: ${mutationResult.data.collectionUpdate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
          });
        } else if (mutationResult.errors) {
          errors.push({
            row: rowIndex,
            message: `Collection update GraphQL errors: ${JSON.stringify(mutationResult.errors.map(e => e.message).join(", "))}`,
          });
        } else {
          updatedCollectionsCount++;
          // Success message can be logged if needed
        }
      } else { // Create
        mutationResponse = await admin.graphql(COLLECTION_MUTATION, {
          variables: { input: collectionInput },
        });
        mutationResult = await mutationResponse.json();

        if (mutationResult.data?.collectionCreate?.userErrors?.length > 0) {
          errors.push({
            row: rowIndex,
            message: `Collection creation errors: ${mutationResult.data.collectionCreate.userErrors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
          });
        } else if (mutationResult.errors) {
          errors.push({
            row: rowIndex,
            message: `Collection creation GraphQL errors: ${JSON.stringify(mutationResult.errors.map(e => e.message).join(", "))}`,
          });
        } else {
          createdCollectionsCount++;
          const newCollectionId = mutationResult.data.collectionCreate.collection.id;
          if (newCollectionId) {
            collectionInput.id = newCollectionId; // Update ID for subsequent metafield creation
          }
          // Success message can be logged if needed
        }
      }

    } catch (e) {
      console.error(`Error ${mutationType} collection ${title} (row ${rowIndex}):`, e);
      errors.push({ row: rowIndex, message: `Collection ${mutationType} failed for "${title}": ${e.message}` });
      continue; // Skip metafield update if collection failed to create/update
    }


    // --- Metafields Update ---
    if (!collectionInput.id) {
      errors.push({ row: rowIndex, message: `Skipping metafield updates for "${title}" as collection ID is not available.` });
      continue;
    }

    const metafieldsToSet = [];
    for (const [header, colIndex] of headerMap.entries()) {
      // Skip default columns and rule columns
      if (
        ["Collection ID", "Title", "Description", "Sort Order", "Template Suffix", "Collection Type", "Smart Collection: Applied Disjunctively"].includes(header) ||
        header.startsWith("Rule ")
      ) {
        continue;
      }

      const rawValue = row.getCell(colIndex)?.value;
      const key = header;

      // Determine the metafield's defined type and namespace
      const existingMetafieldDef = originalMetafieldDefinitionsMap[key];
      const shopifyDefinedType = existingMetafieldDef?.type || "single_line_text_field"; // Default to text if not found
      const metafieldNamespace = existingMetafieldDef?.namespace || "custom"; // Use existing namespace, default to 'custom'

      const valueForApi = convertValueForShopifyType(rawValue, shopifyDefinedType);

      // Only add to metafieldsToSet if the value is not undefined (meaning it was processed by convertValueForShopifyType)
      // and if it's not null (which means we want to clear/delete the value)
      if (valueForApi !== undefined) {
        metafieldsToSet.push({
          ownerId: collectionInput.id,
          namespace: metafieldNamespace, // Use the determined namespace!
          key: key,
          type: shopifyDefinedType,
          value: valueForApi !== null ? String(valueForApi) : null, // Ensure value is string or null
        });
      }
    }

    if (metafieldsToSet.length > 0) {
      try {
        console.log(`Attempting to set metafields for collection ID: ${collectionInput.id} (Row ${rowIndex})`);
        console.log("Metafields payload:", JSON.stringify(metafieldsToSet, null, 2)); // <-- CRITICAL LOG

        const metafieldResponse = await admin.graphql(SET_METAFIELDS_MUTATION, {
          variables: { metafields: metafieldsToSet },
        });
        const metafieldResult = await metafieldResponse.json();

        if (metafieldResult.errors) {
          console.error(`Metafield update GraphQL errors for row ${rowIndex}:`, JSON.stringify(metafieldResult.errors, null, 2)); // <-- CRITICAL LOG
          errors.push({
            row: rowIndex,
            message: `Metafield update GraphQL errors: ${metafieldResult.errors.map(e => e.message).join(", ")}`
          });
        } else if (metafieldResult.data?.metafieldsSet?.userErrors?.length) {
          console.error(`Metafield update user errors for row ${rowIndex}:`, JSON.stringify(metafieldResult.data.metafieldsSet.userErrors, null, 2)); // <-- CRITICAL LOG
          errors.push({
            row: rowIndex,
            message: `Metafield update user errors: ${metafieldResult.data.metafieldsSet.userErrors.map(e => `${e.field}: ${e.message}`).join("; ")}`,
          });
        } else if (metafieldResult.data?.metafieldsSet?.metafields?.length) {
          updatedMetafieldsCount += metafieldResult.data.metafieldsSet.metafields.length;
          console.log(`Successfully updated ${metafieldResult.data.metafieldsSet.metafields.length} metafields for collection ${collectionInput.id}`);
        }
      } catch (e) {
        console.error(`Network or unexpected error updating metafields for collection ${collectionInput.id} (row ${rowIndex}):`, e);
        errors.push({ row: rowIndex, message: `Metafield update failed for ID ${collectionInput.id}: ${e.message}` });
      }
    }
    processedRowsCount++;
  }

  let summaryMessage = `Import process completed.`;
  let isSuccess = errors.length === 0;

  if (isSuccess) {
    summaryMessage += ` All ${processedRowsCount} rows processed. ${createdCollectionsCount} collections created and ${updatedCollectionsCount} updated. ${updatedMetafieldsCount} metafields set successfully.`;
  } else {
    summaryMessage += ` ${createdCollectionsCount} collections created, ${updatedCollectionsCount} updated, ${updatedMetafieldsCount} metafields set. However, ${errors.length} row(s) had errors.`;
  }

  return json({
    success: isSuccess,
    message: summaryMessage,
    errors,
    processedRowsCount,
    updatedCollectionsCount,
    createdCollectionsCount,
    updatedMetafieldsCount,
    importedFileName: file.name,
  }, { status: isSuccess ? 200 : 400 });
};


export default function Collections() {
  const { collections, error: loaderError, metafieldDefinitions } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [fileName, setFileName] = useState("");
  const [toastActive, setToastActive] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastError, setToastError] = useState(false);
  const [importErrors, setImportErrors] = useState([]);

  useEffect(() => {
    if (loaderError) {
      setToastContent(`Error loading collections: ${loaderError}`);
      setToastError(true);
      setToastActive(true);
    }
  }, [loaderError]);

  const handleDownload = useCallback(async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Collections");

    const uniqueMetafields = new Map();
    collections.forEach(col => {
      col.metafields.nodes.forEach(mf => {
        if (!uniqueMetafields.has(mf.key)) {
          // Store namespace for export to ensure it's re-used on import
          uniqueMetafields.set(mf.key, { key: mf.key, type: mf.type, namespace: mf.namespace });
        }
      });
    });

    const metafieldKeysAndTypes = Array.from(uniqueMetafields.values()).sort((a, b) => a.key.localeCompare(b.key));
    const metafieldHeaders = metafieldKeysAndTypes.map(mt => mt.key);

    // Determine max number of rules for any smart collection
    let maxRules = 0;
    collections.forEach(col => {
      if (col.type === "Smart" && col.exportedRules.length > maxRules) {
        maxRules = col.exportedRules.length;
      }
    });

    const ruleHeaders = [];
    for (let i = 1; i <= maxRules; i++) {
      ruleHeaders.push(`Rule ${i} - Column`, `Rule ${i} - Relation`, `Rule ${i} - Condition`);
    }

    const headers = [
      "Collection ID",
      "Title",
      "Description",
      "Sort Order",
      "Template Suffix",
      "Collection Type", // Manual or Smart
      "Smart Collection: Applied Disjunctively", // Changed header text
      ...ruleHeaders, // Dynamic rule headers
      ...metafieldHeaders,
    ];
    worksheet.addRow(headers);

    collections.forEach(col => {
      const metafieldMap = {};
      col.metafields.nodes.forEach(mf => {
        // When exporting, ensure the raw GID is exported for reference types.
        // The displayValue is for UI, actual value is for re-import.
        if (mf.type.endsWith('_reference') || mf.type.startsWith('list.')) {
          metafieldMap[mf.key] = mf.value || ""; // Export the raw value (GID or JSON array of GIDs)
        } else {
          metafieldMap[mf.key] = mf.displayValue || mf.value || "";
        }
      });

      const ruleData = [];
      col.exportedRules.forEach(rule => {
        ruleData.push(rule.column, rule.relation, rule.condition);
      });
      // Pad with empty strings if fewer rules than maxRules
      while (ruleData.length < maxRules * 3) {
        ruleData.push("", "", "");
      }

      // Convert boolean to "Any" or "All" for export
      const appliedDisjunctivelyDisplay = col.type === "Smart"
        ? (col.ruleSet.appliedDisjunctively ? "Any" : "All")
        : "";

      const rowData = [
        col.id,
        col.title,
        col.descriptionHtml,
        col.sortOrder || "",
        col.templateSuffix || "",
        col.type,
        appliedDisjunctivelyDisplay,
        ...ruleData,
        ...metafieldHeaders.map(key => metafieldMap[key] || ""),
      ];
      worksheet.addRow(rowData);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shopify_collections_export.xlsx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, [collections]);

  const handleDrop = useCallback((files, acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      const selectedFile = acceptedFiles[0];
      const formData = new FormData();
      formData.append("file", selectedFile);
      // Pass the known metafield definitions (including namespaces) from the loader to the action
      formData.append("collectionsData", JSON.stringify({ metafieldDefinitions }));

      setFileName(selectedFile.name);
      setImportErrors([]);
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    }
  }, [fetcher, metafieldDefinitions]);

  useEffect(() => {
    if (fetcher.state === "submitting" && fileName) {
      setToastContent(`Importing "${fileName}"... Please wait, this may take a moment.`);
      setToastError(false);
      setToastActive(true);
      setImportErrors([]);
    } else if (fetcher.state === "idle" && actionData) {
      if (actionData.success) {
        setToastContent(actionData.message || "Import completed successfully.");
        setToastError(false);
        setToastActive(true);
        setImportErrors([]);
      } else {
        setToastContent(actionData.error || actionData.message || "Import failed. Check error details below.");
        setToastError(true);
        setToastActive(true);
        if (actionData.errors && Array.isArray(actionData.errors)) {
          setImportErrors(actionData.errors);
        } else if (actionData.details) {
          setImportErrors([{ row: 'N/A', message: actionData.details }]);
        }
      }
    }
  }, [fetcher.data, fetcher.state, fileName, actionData]);

  useEffect(() => {
    if (fetcher.state === "idle" && actionData?.success) {
      revalidator.revalidate(); // Revalidate data after successful import
    }
  }, [fetcher.state, actionData?.success, revalidator]);

  const toggleToastActive = useCallback(() => setToastActive(active => !active), []);

  const loading = navigation.state === "submitting" || fetcher.state === "submitting";

  const rows = collections.map(col => [
    <Link url={`shopify://admin/collections/${col.id.split('/').pop()}`} external>{col.title}</Link>,
    col.handle,
    col.type,
    col.type === "Smart" ? (col.ruleSet.appliedDisjunctively ? "Any" : "All") : "-",
    col.metafields?.nodes?.length || 0,
    new Date(col.updatedAt).toLocaleDateString(),
  ]);

  return (
    <Page>
      <TitleBar title="Collections Export/Import" />
      <Layout>
        <Layout.Section>
          <Card sectioned>
            <LegacyStack spacing="tight" vertical>
              <Text variant="headingMd" as="h2">Export Collections to Excel</Text>
              <Text variant="bodyMd" as="p">Download all your Shopify collections, including their core fields, smart collection rules, and custom metafields, into an Excel file. This file can then be updated and re-imported.</Text>
              <Button onClick={handleDownload} primary disabled={loading || collections.length === 0}>
                {loading && navigation.state !== "submitting" ? <Spinner size="small" /> : `Export Collections (${collections.length} total)`}
              </Button>
            </LegacyStack>
          </Card>

          <Card sectioned title="Import Updated Excel File">
            <LegacyStack spacing="tight" vertical>
              <Text variant="bodyMd" as="p">
                Upload an Excel file (preferably one exported from this app) to update existing collections and their metafields.
                <br />
                <List type="bullet">
                  <List.Item>
                    **Collection ID (Column A):** Leave empty for new collections, use existing GID for updates.
                  </List.Item>
                  <List.Item>
                    **Collection Type:** Enter "Manual" or "Smart".
                  </List.Item>
                  <List.Item>
                    **Smart Collection: Applied Disjunctively:** Enter "Any" (for product must match any condition) or "All" (for product must match all conditions).
                  </List.Item>
                  <List.Item>
                    **Smart Collection Rules:** For "Smart" collections, use `Rule X - Column`, `Rule X - Relation`, `Rule X - Condition` columns to define each rule. Each rule requires all three parts.
                  </List.Item>
                  <List.Item>
                    **Metafields:** Custom metafields start after the standard and rule columns. The header should be the metafield's `key`.
                  </List.Item>
                  <List.Item>
                    **Reference Types (`collection_reference`, `list.collection_reference`, etc.):** Values in Excel must be raw Shopify GID(s). For list types, a valid JSON array string of GIDs (e.g., `["gid://...","gid://..."]`).
                  </List.Item>
                </List>
              </Text>
              <DropZone allowMultiple={false} onDrop={handleDrop} disabled={loading} accept=".xlsx">
                {fileName ? <Text alignment="center">Selected file: {fileName}</Text> : <DropZone.FileUpload actionHint="Accepts .xlsx files only" />}
              </DropZone>
              {loading && <Text alignment="center" variant="bodyMd"><Spinner size="small" /> Processing import... This may take a moment.</Text>}
            </LegacyStack>
          </Card>

          {importErrors.length > 0 && (
            <Layout.Section>
              <Card sectioned title="Import Errors Detected">
                <LegacyStack vertical spacing="tight">
                  <Text color="critical" variant="headingSm">The following issues were found during the import:</Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["Row #", "Error Message"]}
                    rows={importErrors.map(err => [err.row || 'N/A', err.message])}
                  />
                  <Text>Please correct these issues in your Excel file and try re-importing.</Text>
                </LegacyStack>
              </Card>
            </Layout.Section>
          )}
        </Layout.Section>

        {collections.length > 0 && (
          <Layout.Section>
            <Card title={`Existing Collections (${collections.length})`} sectioned>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric", "text"]}
                headings={["Title", "Handle", "Type", "Smart Logic", "Metafields Count", "Updated At"]}
                rows={rows}
              />
            </Card>
          </Layout.Section>
        )}
      </Layout>

      {toastActive && (
        <Frame>
          <Toast content={toastContent} error={toastError} onDismiss={toggleToastActive} duration={5000} />
        </Frame>
      )}
    </Page>
  );
}