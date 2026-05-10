import { Share, Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

export async function shareViewAsImage(viewRef: React.RefObject<any>): Promise<boolean> {
  try {
    const uri = await captureRef(viewRef, {
      format: 'png',
      quality: 1,
    });

    const shareUrl = Platform.OS === 'ios' ? uri : `file://${uri}`;

    await Share.share(
      Platform.OS === 'ios'
        ? { url: shareUrl }
        : { message: 'Check out my tir result!', title: 'tir result' },
    );
    return true;
  } catch {
    return false;
  }
}
