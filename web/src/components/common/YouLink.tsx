import { navigate } from '../../hooks/useRoute';
import classes from './YouLink.module.css';
import { useYou } from './you';

// The round initial on Home's header: Settings, and who's signed in. Computers have
// Settings in the sidebar instead.
export default function YouLink() {
  const you = useYou();
  if (you == null) return null;
  return (
    <a
      href="?settings"
      className={classes.initial}
      aria-label="You and settings"
      onClick={(e) => {
        e.preventDefault();
        navigate('?settings');
      }}
    >
      {you.initial}
    </a>
  );
}
