import type { CSSProperties } from "react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "sonner";
import { IconContext } from "react-icons";
import AuthProvider from "./auth/AuthProvider.tsx";
import { iconContext, routes } from "./routes.tsx";

const router = createBrowserRouter(routes);

function App() {
  return (
    <IconContext value={iconContext}>
      <AuthProvider>
        <RouterProvider router={router} />
        {/* sonner themes toasts through CSS variables, so point them at ours. */}
        <Toaster
          position="top-center"
          style={
            {
              "--normal-bg": "var(--color-surface)",
              "--normal-text": "var(--color-ink)",
              "--normal-border": "var(--color-line)",
              "--border-radius": "var(--radius-xl)",
              fontFamily: "var(--font-sans)",
            } as CSSProperties
          }
          toastOptions={{ classNames: { error: "[&_[data-icon]]:text-danger" } }}
        />
      </AuthProvider>
    </IconContext>
  );
}

export default App;
