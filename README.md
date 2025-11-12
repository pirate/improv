# Improv - AI Userscript Creator

A Chrome extension that lets you create custom JavaScript userscripts for any website using AI assistance.

## Features

- **AI-Powered Script Creation**: Use OpenAI's API to generate custom userscripts
- **Interactive Testing**: The AI can execute JavaScript on the page and see results before committing
- **User Approval Workflow**: Review and approve changes before they're saved
- **Automatic Script Management**: Scripts automatically run on matching pages
- **Built-in Chat Interface**: Iterate with the AI to refine your scripts

## How It Works

1. Click the extension icon to open the side panel
2. Click "New Script" to start creating a userscript
3. Describe what you want to change on the current page
4. The AI will:
   - Analyze the page (screenshot, HTML, console logs)
   - Execute test JavaScript to try different solutions
   - Ask for your approval after each attempt
5. When satisfied, the AI saves the script to run automatically on future visits

## Setup

1. Build the extension:
   ```bash
   bun install
   bun run build
   ```

2. Load the extension in Chrome:
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `build` directory

3. Configure API settings:
   - Click the extension icon
   - Click "Settings"
   - Enter your OpenAI API key
   - Optionally customize the API URL and model name

## Architecture

- **Content Script**: Executes on all pages, runs userscripts, handles JS execution requests
- **Background Script**: Routes messages between side panel and content scripts, captures screenshots
- **Side Panel**: React UI for managing scripts and chatting with the AI
- **Storage**: Uses `chrome.storage.local` to persist userscripts and chat histories

## LLM Tools

The AI has access to two tools:

1. **execute_js(code: string)**: Execute JavaScript on the current page and see console output
2. **submit_final_userscript(matchUrls: string, jsScript: string)**: Save the final userscript

## User Approval Flow

After each `execute_js` call, the user sees the output and can choose:
- **Yes, save it**: Saves the script for automatic execution
- **Keep trying**: Provide feedback and continue iterating
- **Refresh & retry**: Reset the conversation and try from scratch

## Storage Schema

### Userscript
```typescript
{
  id: string;
  name: string;
  matchUrls: string; // Regex pattern
  jsScript: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}
```

### ChatHistory
```typescript
{
  id: string;
  userscriptId: string | null;
  apiUrl: string;
  modelName: string;
  messages: ChatMessage[];
  initialPrompt: string;
  initialUrl: string;
  initialScreenshot: string;
  initialHtml: string;
  initialConsoleLog: string;
  createdAt: number;
  updatedAt: number;
}
```

## Development

- `bun run dev`: Watch mode for development
- `bun run build`: Build for production
- `bun run pack`: Create a packaged zip file

## Tech Stack

- TypeScript
- React
- Bun (build tool)
- Tailwind CSS
- Chrome Extensions Manifest V3
