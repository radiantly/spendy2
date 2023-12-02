import { Link, useMatch, useNavigate, useLocation } from "react-router-dom";
import Logo from "../components/Logo";
import {
  container,
  box,
  submitRow,
  alternateAction,
  info,
} from "../css/LoginRegisterPage.module.css";
import { useEffect, useRef, useState } from "react";
import { generateKeyPair, postJSON, toPem } from "../utils.jsx";
function LoginRegisterPage() {
  const isRegister = useMatch("/register");
  const navigate = useNavigate();
  const loc = useLocation();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const txt = isRegister
    ? {
        submit: "Create account",
        alternate: "Sign in",
        link: "/login",
      }
    : {
        submit: "Login",
        alternate: "Create an account",
        link: "/register",
      };

  const [feedback, setFeedback] = useState(null);
  const feedbackRef = useRef(null);
  useEffect(() => setFeedback(loc?.state?.feedback), [loc]);

  const register = async ({ publicKey }) => {
    setFeedback("Creating account..");
    const response = await postJSON("/api/user", {
      username,
      public_key: publicKey,
    });

    console.log(response);

    if (response.status == 200)
      return navigate("/login", {
        state: {
          feedback: "Your account has been created, you can login now.",
        },
      });

    setFeedback(
      `Failed to create account. The username ${username} may already be in use.`
    );
  };
  const login = async (keypair) => {
    setFeedback("Logging in..");
    localStorage.setItem("user", JSON.stringify({ username, keypair }));
    return navigate("/");
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    // manually set feedback because generating a keypair using node forge
    // freezes the main thread
    feedbackRef.current.classList.remove("hidden");
    feedbackRef.current.innerText =
      "Generating keypair - this may take a few seconds.";

    setTimeout(() => {
      const keypair = toPem(generateKeyPair(password));
      console.debug("generated keypair", keypair);

      isRegister ? register(keypair) : login(keypair);
    }, 0);
  };

  return (
    <div className={container}>
      <form className={box} onSubmit={handleSubmit}>
        <Logo />
        {isRegister && (
          <div
            className={info}
          >{`Choose a username and send your transactional emails to ${
            username || "username"
          }@${location.hostname}`}</div>
        )}
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
        <div
          className={[info, feedback ? "" : "hidden"].join(" ")}
          ref={feedbackRef}
        >
          {feedback}
        </div>
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

export default LoginRegisterPage;
