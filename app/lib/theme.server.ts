import { gql, type AdminGraphql } from "./shop.server";

/**
 * Whether the CartLift app embed is switched on in the live theme.
 * Reads config/settings_data.json of the MAIN theme (needs read_themes).
 * Returns null when it can't tell, so the UI shows a neutral state.
 */
export async function embedStatus(admin: AdminGraphql): Promise<{ enabled: boolean | null; themeName?: string }> {
  try {
    const data = await gql<{
      themes: {
        nodes: {
          name: string;
          files: { nodes: { body: { content?: string } }[] };
        }[];
      };
    }>(
      admin,
      `#graphql
        query cartliftMainTheme {
          themes(first: 1, roles: [MAIN]) {
            nodes {
              name
              files(filenames: ["config/settings_data.json"], first: 1) {
                nodes { body { ... on OnlineStoreThemeFileBodyText { content } } }
              }
            }
          }
        }`,
    );
    const theme = data.themes.nodes[0];
    const content = theme?.files.nodes[0]?.body?.content;
    if (!theme || !content) return { enabled: null, themeName: theme?.name };

    // settings_data.json may start with a /* … */ comment block.
    const json = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, ""));
    const blocks = (json?.current?.blocks ?? {}) as Record<string, { type?: string; disabled?: boolean }>;
    const enabled = Object.values(blocks).some(
      (b) => typeof b.type === "string" && b.type.includes("/blocks/cartlift-embed/") && !b.disabled,
    );
    return { enabled, themeName: theme.name };
  } catch (error) {
    console.error("Embed status check failed", error);
    return { enabled: null };
  }
}

/** The live theme's config/settings_data.json, parsed (null when unreadable). */
export async function themeSettings(admin: AdminGraphql): Promise<unknown | null> {
  try {
    const data = await gql<{ themes: { nodes: { files: { nodes: { body: { content?: string } }[] } }[] } }>(
      admin,
      `#graphql
        query cartliftThemeSettings {
          themes(first: 1, roles: [MAIN]) {
            nodes { files(filenames: ["config/settings_data.json"], first: 1) { nodes { body { ... on OnlineStoreThemeFileBodyText { content } } } } }
          }
        }`,
    );
    const content = data.themes.nodes[0]?.files.nodes[0]?.body?.content;
    // settings_data.json may start with a /* … */ comment block.
    return content ? JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\//, "")) : null;
  } catch (error) {
    console.error("Theme settings read failed", error);
    return null;
  }
}

export function embedDeepLink(domain: string, apiKey: string) {
  return `https://${domain}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/cartlift-embed`;
}

export function blockDeepLink(domain: string, apiKey: string) {
  return `https://${domain}/admin/themes/current/editor?template=product&addAppBlockId=${apiKey}/cartlift-deals&target=mainSection`;
}
