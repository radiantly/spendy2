import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "react-hot-toast";
import RegisterPage from "./pages/register/RegisterPage.tsx";

// `/` and `/login` are placeholders until those pages are built.
const router = createBrowserRouter([
  { path: "/", element: <p className="p-8">Dashboard</p> },
  { path: "/login", element: <p className="p-8">Login</p> },
  { path: "/register", element: <RegisterPage /> },
]);

function App() {
  return (
    <>
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
    </>
  );
}

export default App;
