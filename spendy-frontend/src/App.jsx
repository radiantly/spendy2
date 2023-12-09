import { Route, Routes, useNavigate } from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";
import LoginRegisterPage from "./pages/LoginRegisterPage";
import { useEffect, useMemo, useState } from "react";
import { UserContext } from "./contexts/UserContext.js";
import { User } from "./utils.jsx";

function App() {
  const [user, setUser] = useState(null);
  const userState = useMemo(() => [user, setUser], [user]);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      const retrieved_user = await User.fromJSONString(
        localStorage.getItem("user")
      );
      console.log(retrieved_user);
      if (retrieved_user) setUser(retrieved_user);
      else navigate("/login");
    })();
  }, []);

  useEffect(() => {
    if (user) localStorage.setItem("user", JSON.stringify(user));
  }, [user]);

  return (
    <UserContext.Provider value={userState}>
      <Routes>
        <Route path="/" element={user ? <TransactionsPage /> : null} />
        <Route path="login" element={<LoginRegisterPage />} />
        <Route path="register" element={<LoginRegisterPage />} />
      </Routes>
    </UserContext.Provider>
  );
}
export default App;
