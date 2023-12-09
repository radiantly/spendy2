import { Link, useMatch, useNavigate, useLocation } from "react-router-dom";
import Logo from "../components/Logo";
import {
  container,
  box,
  submitRow,
  alternateAction,
  info,
} from "../css/LoginRegisterPage.module.css";
import { useContext, useEffect, useState } from "react";
import { Keypair, Session, User } from "../utils.jsx";
import { UserContext } from "../contexts/UserContext.js";
function LoginRegisterPage() {
  const isRegister = useMatch("/register");
  const navigate = useNavigate();
  const loc = useLocation();
  const [, setUser] = useContext(UserContext);

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
  useEffect(() => setFeedback(loc?.state?.feedback), [loc]);

  const setFeedbackFromResponse = async (response) => {
    try {
      const { detail } = await response.json();
      return setFeedback(detail);
    } catch {
      return setFeedback("Could not login. Server Error.");
    }
  };

  const register = async (keypair) => {
    setFeedback("Creating account..");
    const payload = {
      username,
      public_key: keypair.publicKey,
    };
    const response = await fetch("/api/user", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    console.log(response);

    if (response.status !== 200) return setFeedbackFromResponse(response);

    return navigate("/login", {
      state: {
        feedback: "Your account has been created, click login below.",
      },
    });
  };
  const login = async (keypair) => {
    var formdata = new FormData();
    formdata.append("username", username);
    formdata.append("password", keypair.publicKey);

    const response = await fetch("/api/token", {
      method: "POST",
      body: formdata,
    });
    if (response.status !== 200) return setFeedbackFromResponse(response);

    const { access_token } = await response.json();
    const session = new Session(access_token);
    const user = new User(username, keypair, session);

    setUser(user);
    return navigate("/");
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    setFeedback("Generating keypair - this may take a few seconds.");

    setTimeout(async () => {
      const keypair = await Keypair.generate(password);
      console.log("generating with", password);
      isRegister ? register(keypair) : login(keypair);
    }, 222);
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
        <div className={[info, feedback ? "" : "hidden"].join(" ")}>
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
