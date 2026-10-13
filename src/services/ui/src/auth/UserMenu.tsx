import {
  Avatar,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { authEnabled } from './config';
import { useAuthStore } from './store';

/** Topbar identity affordance: shows who is signed in and offers sign-out.
 *  Renders nothing when auth is disabled or no user is present. */
export function UserMenu(): JSX.Element | null {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);

  if (!authEnabled() || status !== 'authenticated' || !user) {
    return null;
  }

  const display = user.name || user.preferred_username || user.sub;

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <button type="button" className="user-menu-trigger" aria-label={`Signed in as ${display}`}>
          <Avatar name={display} size={28} color="colorful" />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem disabled>{display}</MenuItem>
          <MenuItem onClick={() => void logout()}>Sign out</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
