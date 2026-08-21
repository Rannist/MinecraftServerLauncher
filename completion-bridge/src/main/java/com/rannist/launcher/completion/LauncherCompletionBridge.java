package com.rannist.launcher.completion;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandMap;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.plugin.java.JavaPlugin;

public final class LauncherCompletionBridge extends JavaPlugin {
    private static final String READY_MARKER = "@@MSL-BRIDGE-READY@@";
    private static final String RESULT_MARKER = "@@MSL-COMPLETE@@";

    private CommandMap commandMap;

    @Override
    public void onEnable() {
        commandMap = resolveCommandMap();
        System.out.println(READY_MARKER);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof ConsoleCommandSender) || args.length != 2) return true;
        String requestId = args[0].replaceAll("[^0-9A-Za-z_-]", "");
        if (requestId.isEmpty()) return true;

        List<String> suggestions = Collections.emptyList();
        try {
            String commandLine = new String(Base64.getUrlDecoder().decode(args[1]), StandardCharsets.UTF_8);
            if (commandMap == null) commandMap = resolveCommandMap();
            if (commandMap != null && commandLine.length() <= 1000) {
                List<String> completed = commandMap.tabComplete(Bukkit.getConsoleSender(), commandLine);
                suggestions = completed == null ? Collections.<String>emptyList() : completed;
            }
        } catch (Exception ignored) {
            // An empty result is safer than printing protocol details into the server console.
        }

        List<String> encoded = new ArrayList<>();
        for (String suggestion : suggestions) {
            if (encoded.size() >= 200 || suggestion == null || suggestion.equalsIgnoreCase("mslcomplete")) continue;
            encoded.add(Base64.getUrlEncoder().withoutPadding().encodeToString(suggestion.getBytes(StandardCharsets.UTF_8)));
        }
        System.out.println(RESULT_MARKER + requestId + "@@" + String.join(",", encoded));
        return true;
    }

    private CommandMap resolveCommandMap() {
        try {
            Method method = Bukkit.getServer().getClass().getMethod("getCommandMap");
            return (CommandMap) method.invoke(Bukkit.getServer());
        } catch (Exception ignored) {
            try {
                Field field = Bukkit.getPluginManager().getClass().getDeclaredField("commandMap");
                field.setAccessible(true);
                return (CommandMap) field.get(Bukkit.getPluginManager());
            } catch (Exception unavailable) {
                getLogger().warning("Cannot access the server command map; launcher completion is unavailable.");
                return null;
            }
        }
    }
}
