import { Link, useMatch } from "react-router-dom";
import Logo from "../components/Logo";
import {
  container,
  box,
  submitRow,
  alternateAction,
  info,
} from "../css/LoginRegisterPage.module.css";
import { useState } from "react";
import { generateKeyPair, postJSON } from "../utils";
function LoginRegisterPage() {
  const isRegister = useMatch("/register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const txt = isRegister
    ? {
        submit: "Create account",
        alternate: "Sign in",
        link: "/login",
        info: `Choose a username and send your transactional emails to ${
          username || "username"
        }@${location.hostname}`,
      }
    : {
        submit: "Login",
        alternate: "Create an account",
        link: "/register",
      };

  const register = (e) => {
    const keypair = generateKeyPair(password);
    console.debug("generated keypair", keypair);

    // postJSON("/api/user", {
    //   username,

    // })
    e.preventDefault();
  };
  const login = () => {};

  return (
    <div className={container}>
      <form
        className={box}
        onSubmit={(e) => (isRegister ? register(e) : login(e))}
      >
        <Logo />
        <Info text={txt.info} />
        <input
          placeholder="Username"
          required
          value={username}
          onInput={(e) => setUsername(e.target.value)}
          maxLength={32}
        />
        <input
          placeholder="Password"
          type="password"
          required
          value={password}
          onInput={(e) => setPassword(e.target.value)}
        />
        <div className={submitRow}>
          <input type="submit" value={txt.submit} />
          <Link className={alternateAction} to={txt.link}>
            {txt.alternate}
          </Link>
        </div>
      </form>
    </div>
  );
}

function Info({ text }) {
  if (!text) return null;
  return <div className={info}>{text}</div>;
}

export default LoginRegisterPage;
