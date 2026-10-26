import React from 'react';
import type { ScreenProps } from '../../navigation/types.js';
import { InviteFriendsScreen } from './InviteFriendsScreen.js';

export function InviteFriendsRouteScreen({ navigation }: ScreenProps<'InviteFriends'>) {
  return <InviteFriendsScreen onBack={() => navigation.goBack()} />;
}
