# Chrome Web Store Publishing Setup

This document explains how to set up automated publishing to the Chrome Web Store via GitHub Actions.

## Required Secrets

You need to configure the following secrets in your GitHub repository settings (Settings → Secrets and variables → Actions → New repository secret):

### 1. `CHROME_EXTENSION_ID`
- **Description**: Your Chrome Web Store extension ID
- **How to get it**:
  1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
  2. Find your extension (or create a new one if this is the first release)
  3. The extension ID is in the URL: `https://chrome.google.com/webstore/detail/[EXTENSION_ID]`
  4. Or click on your extension and look for the ID in the details

### 2. `CHROME_CLIENT_ID`
- **Description**: OAuth 2.0 Client ID for Chrome Web Store API access
- **How to get it**:
  1. Go to [Google Cloud Console](https://console.cloud.google.com/)
  2. Create a new project or select an existing one
  3. Enable the Chrome Web Store API:
     - Go to "APIs & Services" → "Library"
     - Search for "Chrome Web Store API"
     - Click "Enable"
  4. Create OAuth 2.0 credentials:
     - Go to "APIs & Services" → "Credentials"
     - Click "Create Credentials" → "OAuth client ID"
     - Application type: "Chrome App"
     - Enter the extension ID from step 1
     - Save the Client ID

### 3. `CHROME_CLIENT_SECRET`
- **Description**: OAuth 2.0 Client Secret (generated with the Client ID above)
- **How to get it**: Available immediately after creating the OAuth client ID in step 2 above

### 4. `CHROME_REFRESH_TOKEN`
- **Description**: OAuth 2.0 Refresh Token for API authentication
- **How to get it**:
  1. Use this tool to generate a refresh token: [Chrome Web Store Token Generator](https://github.com/DrewML/chrome-webstore-upload/blob/master/How%20to%20generate%20Google%20API%20keys.md)
  2. Or use curl to get it manually:
     ```bash
     # Step 1: Get authorization code
     # Visit this URL in your browser (replace CLIENT_ID):
     https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob

     # Step 2: Exchange code for refresh token
     curl "https://accounts.google.com/o/oauth2/token" \
       -d "client_id=CLIENT_ID" \
       -d "client_secret=CLIENT_SECRET" \
       -d "code=AUTHORIZATION_CODE" \
       -d "grant_type=authorization_code" \
       -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"

     # The response will contain your refresh_token
     ```

## GitHub Actions Workflow

Due to GitHub App permission restrictions, you'll need to manually create this workflow file.

**Create the file**: `.github/workflows/publish-chrome-extension.yml`

```yaml
name: Publish to Chrome Web Store

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build and pack extension
        run: bun run pack

      - name: Get version from manifest
        id: version
        run: |
          VERSION=$(cat public/manifest.json | grep '"version"' | sed 's/.*"version": "\(.*\)".*/\1/')
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Publish to Chrome Web Store
        uses: mnao305/chrome-extension-upload@v5.0.0
        with:
          file-path: ./release/improv-ai-userscript-creator-v${{ steps.version.outputs.version }}.zip
          extension-id: ${{ secrets.CHROME_EXTENSION_ID }}
          client-id: ${{ secrets.CHROME_CLIENT_ID }}
          client-secret: ${{ secrets.CHROME_CLIENT_SECRET }}
          refresh-token: ${{ secrets.CHROME_REFRESH_TOKEN }}
          publish: true
```

## Setup Instructions

1. **Add the workflow file**: Create `.github/workflows/publish-chrome-extension.yml` with the content above

2. **Configure secrets**: Add all 4 required secrets to your GitHub repository:
   - Go to Settings → Secrets and variables → Actions
   - Add each secret with the exact names shown above

3. **Create a release**:
   - Make sure your `public/manifest.json` has the correct version
   - Create a new GitHub release with a tag (e.g., `v0.1.0`)
   - The workflow will automatically trigger and publish to the Chrome Web Store

4. **First-time setup**: For the first release, you may need to:
   - Upload the extension manually once to the Chrome Web Store to get the extension ID
   - Complete the store listing (description, screenshots, privacy policy, etc.)
   - After that, automated publishing will update the existing extension

## Workflow Behavior

- **Trigger**: Automatically runs when you create a new GitHub release
- **Build**: Installs dependencies, builds the extension, and creates a zip file
- **Publish**: Uploads the zip to the Chrome Web Store and publishes it immediately
- **Version**: Uses the version from `public/manifest.json`

## Troubleshooting

- **Build fails**: Make sure Bun can build your extension locally first with `bun run pack`
- **Authentication fails**: Verify all 4 secrets are correctly configured
- **Version mismatch**: Ensure the version in `manifest.json` matches your release tag
- **Extension not found**: Make sure you've done the first manual upload to get the extension ID

## Optional: Staging Process

If you want to test the upload without immediately publishing:

1. Change `publish: true` to `publish: false` in the workflow
2. The extension will be uploaded but not published
3. You can manually publish from the Chrome Web Store dashboard
4. Change back to `publish: true` when ready for full automation
