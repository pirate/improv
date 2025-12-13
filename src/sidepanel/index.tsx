import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Error boundary to prevent the entire sidebar from crashing
class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ hasError: boolean; error: Error | null }
> {
	constructor(props: { children: React.ReactNode }) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error("Sidebar error:", error, errorInfo);
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="p-4 bg-red-50 text-red-800 h-screen flex flex-col">
					<h2 className="font-bold text-lg mb-2">Something went wrong</h2>
					<p className="text-sm mb-4">
						{this.state.error?.message || "An unexpected error occurred"}
					</p>
					<button
						type="button"
						onClick={() => {
							this.setState({ hasError: false, error: null });
							window.location.reload();
						}}
						className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 self-start"
					>
						Reload Sidebar
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}

const container = document.getElementById("root");

if (container) {
	const root = createRoot(container);
	root.render(
		<ErrorBoundary>
			<App />
		</ErrorBoundary>,
	);
}
