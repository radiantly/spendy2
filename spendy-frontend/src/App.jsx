import {
  BrowserRouter as Router,
  Route,
  Routes,
  redirect,
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
} from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";
import LoginRegisterPage from "./pages/LoginRegisterPage";
import { postJSON } from "./utils";
import forge from "node-forge";

const router = createBrowserRouter([
  {
    path: "/",
    loader: async () => {
      // Get transactions for current user
      const userString = localStorage.getItem("user");
      let user;
      try {
        user = JSON.parse(userString);
        if (!user?.username) throw false;
      } catch {
        throw redirect("/login");
      }

      return postJSON("/api/transactions", {
        username: user.username,
        public_key: user.keypair.publicKey,
      });
    },
    element: <TransactionsPage />,
  },
  {
    path: "login",
    element: <LoginRegisterPage />,
  },
  {
    path: "register",
    element: <LoginRegisterPage />,
  },
]);

function App() {
  return <RouterProvider router={router} />;
}
export default App;
