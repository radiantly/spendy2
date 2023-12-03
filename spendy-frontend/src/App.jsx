import {
  redirect,
  createBrowserRouter,
  RouterProvider,
} from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";
import LoginRegisterPage from "./pages/LoginRegisterPage";
import { decryptText, fromPem, postJSON } from "./utils.jsx";

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

      const response = await postJSON("/api/transactions", {
        username: user.username,
        public_key: user.keypair.publicKey,
      });

      if (response.status != 200) {
        localStorage.removeItem("user");
        throw redirect("/login");
      }

      const keypair = fromPem(user.keypair);
      const encryptedTransactions = await response.json();
      const transactions = encryptedTransactions.map(
        ({ id, date, encrypted }) => ({
          id,
          date: new Date(date),
          remarks: "",
          hidden: false,
          ...JSON.parse(decryptText(keypair.privateKey, encrypted)),
        })
      );
      for (const transaction of transactions) {
        if (transaction.remarks == "" && transaction.labels) {
          transaction.remarks = transaction.labels.join(" ");
        }
      }
      return transactions;
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
