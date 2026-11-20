import { Platform } from "react-native";
import { selectCopy } from "../lib/platformCopy";
import { syncOffered } from "./system";

export const selectPlatformCopy = () => selectCopy(Platform.OS, syncOffered());

export const platformOS = Platform.OS;
