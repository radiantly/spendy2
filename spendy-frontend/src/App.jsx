import {
  redirect,
  createBrowserRouter,
  RouterProvider,
} from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";
import LoginRegisterPage from "./pages/LoginRegisterPage";
import { Keypair, postJSON } from "./utils.jsx";

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

      const keypair = await Keypair.fromJSON(user.keypair);

      const response = await postJSON("/api/transactions", {
        username: user.username,
        public_key: keypair.publicKey,
      });

      if (response.status != 200) {
        localStorage.removeItem("user");
        throw redirect("/login");
      }

      const transactions = await response.json();

      return await Promise.all(
        transactions.map(async ({ id, date, encrypted }) => {
          const transaction = {
            id,
            date: new Date(date),
            remarks: "",
            hidden: false,
            ...JSON.parse(await keypair.decrypt(encrypted)),
          };

          if (!transaction.remarks && transaction.labels)
            transaction.remarks = transaction.labels.join(" ");

          return transaction;
        })
      );
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
