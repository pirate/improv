# Improv - AI Userscript Creator

A Chrome extension that lets you create custom mods and patches for any live website using AI assistance.

Can be combined with Browserbase/Stagehand to modify sites to make them easier to automate with AI, or to create repeatable actions triggered by custom buttons added to the site.


<img width="2013" height="1203" alt="Screenshot 2025-11-18 at 11 01 49 AM" src="https://github.com/user-attachments/assets/529de6fc-2c56-4649-8915-46bd77192492" /><br/>
<img width="32%" src="https://github.com/user-attachments/assets/1a9dc541-dcda-473c-869d-7e7428cab0de" />
<img width="32%" src="https://github.com/user-attachments/assets/68bb10c6-3a11-4130-bb80-16b84051d924" />
<img width="32%" src="https://github.com/user-attachments/assets/8990eb27-b3f8-4798-ba6b-591751ea7291" />
<img width="19%" height="962" alt="Screenshot 2025-12-12 at 1 48 44 PM" src="https://github.com/user-attachments/assets/6b5d7851-20cd-4852-b65b-e84f121986a5" />
<img width="40%" height="400" alt="Screenshot 2025-12-12 at 3 04 20 PM" src="https://github.com/user-attachments/assets/295c6257-f31f-41e9-ba24-8a709aee9c5f" />
<img width="40%" height="800" alt="Screenshot 2025-12-12 at 1 46 11 PM" src="https://github.com/user-attachments/assets/d82f56f6-17c0-4c79-ac93-51813e96cebc" />



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

## Privacy

This extension does not connect to any cloud service and we don't collect any user PII or telemetry from extension users.

The only network requests the extension makes are to the LLM provider (OpenAI by default, using the key you provide), and to GreasyFork/OpenUserJS to fetch the list of applicable user scripts you can import.
Only the domain portion of the URL is sent to GreasyFork/OpenUserJS (when the extension sidebar is open and no mod is actively being edited) to fetch matching userscripts for import.

Full page HTML and screenshot are sent to the LLM provider so that the model has context to know how to modify the page. OpenAI's privacy policy covering that data can be found here: https://openai.com/policies/row-privacy-policy/
