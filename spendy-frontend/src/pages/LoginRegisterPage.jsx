import {
  Link,
  useMatch,
  redirect,
  useNavigate,
  useLocation,
} from "react-router-dom";
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
import forge from "node-forge";
function LoginRegisterPage() {
  const isRegister = useMatch("/register");
  const navigate = useNavigate();
  const loc = useLocation();
  const [infoText, setInfoText] = useState(loc?.state?.info);
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

  const register = async () => {
    const keypair = generateKeyPair(password);
    console.debug("generated keypair", keypair);

    const response = await postJSON("/api/user", {
      username,
      public_key: forge.pki.publicKeyToPem(keypair.publicKey),
    });

    console.log(response);

    if (response.status == 200)
      return navigate("/login", {
        state: { info: "Your account has been created, login below:" },
      });

    setInfoText(
      `Failed to create an account. The username ${username} may already be in use.`
    );
  };
  const login = async () => {
    const keypair = generateKeyPair(password);

    localStorage.setItem("user", JSON.stringify({ username, keypair }));
    return navigate("/");
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    return isRegister ? register() : login();
  };

  return (
    <div className={container}>
      <form className={box} onSubmit={handleSubmit}>
        <Logo />
        <Info text={infoText || txt.info} />
        <input
          placeholder="Username"
          required
          value={username}
          onInput={(e) => setUsername(e.target.value.toLowerCase())}
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
