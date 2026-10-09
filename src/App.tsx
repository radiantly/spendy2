import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "react-hot-toast";
import { IconContext } from "react-icons";
import AuthProvider from "./auth/AuthProvider.tsx";
import { iconContext, routes } from "./routes.tsx";

const router = createBrowserRouter(routes);

function App() {
  return (
    <IconContext value={iconContext}>
      <AuthProvider>
        <RouterProvider router={router} />
        {/* react-hot-toast styles toasts inline, so theme them via CSS variables. */}
        <Toaster
          toastOptions={{
            style: {
              background: "var(--color-surface)",
              color: "var(--color-ink)",
              border: "1px solid var(--color-line)",
              borderRadius: "var(--radius-xl)",
              fontFamily: "var(--font-sans)",
            },
            error: {
              iconTheme: {
                primary: "var(--color-danger)",
                secondary: "var(--color-surface)",
              },
            },
          }}
        />
      </AuthProvider>
    </IconContext>
  );
}

export default App;
