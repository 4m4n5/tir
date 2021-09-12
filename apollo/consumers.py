import json
from apollo.models import LoggedInUser, Player, TargetWord
from apollo.helpers import STARTER_WORDS, TARGET_WORDS, wordnet_lemmatizer
from asgiref.sync import async_to_sync, sync_to_async
from channels.generic.websocket import WebsocketConsumer
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async

from apollo.models import LoggedInUser, Player, TargetWord
import random
from nltk.stem import WordNetLemmatizer
from tir.settings import MODEL_PATH, MODEL


class Consumer(AsyncWebsocketConsumer):
    @database_sync_to_async
    def log_player_in(self, username):
        player = Player.objects.get(name=username)
        player.is_logged_in = True
        player.save()

    @database_sync_to_async
    def log_player_out(self, username):
        player = Player.objects.get(name=username)
        player.is_logged_in = False
        player.save()

    @database_sync_to_async
    def add_word_to_player_path(self, username, word):
        player = Player.objects.get(name=username)
        player.add_to_path(word)
        player.save()

    @database_sync_to_async
    def give_player_points(self, username, num_points):
        player = Player.objects.get(name=username)
        player.add_points(num_points)
        player.save()

    @database_sync_to_async
    def get_player_path(self, username):
        player = Player.objects.get(name=username)
        return player.get_path_list()

    @database_sync_to_async
    def get_active_users(self):
        users = Player.objects.filter(is_logged_in=True)
        return users, len(users)

    @database_sync_to_async
    def complete_current_word(self, completed_in, completed_from, completed_path):
        completed_word = TargetWord.objects.latest("datetime").word
        completed_word.completed_in = completed_in
        completed_word.completed_from = completed_from
        completed_word.path = completed_path
        completed_word.save()

    @database_sync_to_async
    def get_target_word(self):
        return TargetWord.objects.latest("datetime").word

    @database_sync_to_async
    def get_previous_target_word_details(self):
        word = str(TargetWord.objects.order_by("-datetime")[1].word)
        completed_from = str(TargetWord.objects.order_by("-datetime")[1].completed_from)
        completed_in = str(TargetWord.objects.order_by("-datetime")[1].completed_in)

        return [word, completed_from, completed_in]

    @database_sync_to_async
    def get_starter_words(self):
        random.shuffle(STARTER_WORDS)
        return STARTER_WORDS[:4]

    @database_sync_to_async
    def get_leaderboard(self, topn=20):
        leaderboard = []
        top_players = Player.objects.order_by("-points")[:topn]
        for player in top_players:
            leaderboard.append({"name": player.name, "points": player.points})
        return leaderboard

    @database_sync_to_async
    def set_target_word(self, previous_target):
        # Select a random word from bank that is not current word
        word = random.choice(TARGET_WORDS)
        while word == previous_target:
            word = random.choice(TARGET_WORDS)
        TargetWord.objects.create(word=word)

        # Reset path for all users
        path = {"word_list": ["word1"]}
        Player.objects.all().update(path=json.dumps(path))

        return word

    @sync_to_async
    def get_word_options(self, word, pre_used_words, max_options=4):
        # Get 20 more options than worst case
        num_options = len(pre_used_words) + max_options
        # Get options from the model
        options = [x for x, _ in MODEL.most_similar(word, topn=num_options)]
        # Process options
        options = [x.lower().strip() for x in options]
        # Filter options
        # 1. lemmatize every word
        options = [wordnet_lemmatizer.lemmatize(x) for x in options]
        # 2. Remove words that are alredy in player path
        options = [x for x in options if x not in pre_used_words]
        # 3. Remove Duplicates
        options = list(set(options))
        # 4. Shuffle the list
        random.shuffle(options)

        return options[:max_options]

    async def connect(self):
        # Get player's username
        username = self.scope["user"].get_username()
        # Set player's logged in status in DB
        await self.log_player_in(username)
        # Add user to a group
        # Currently everyone is added to the same group
        group_name = "online"
        await self.channel_layer.group_add(group_name, self.channel_name)
        # Accept the connection
        await self.accept()
        # Get payload to send back
        target_word = await self.get_target_word()
        leaderboard = await self.get_leaderboard()
        _, active_users = await self.get_active_users()
        starter_words = await self.get_starter_words()
        [
            previous_target_word,
            completed_from,
            completed_in,
        ] = await self.get_previous_target_word_details()
        # Send message to the relevant group
        await self.channel_layer.group_send(
            group_name,
            {
                "type": "broadcast_active_users",
                "activeUsers": active_users,
                "leaderboard": leaderboard,
            },
        )
        await self.send(
            text_data=json.dumps(
                {
                    "targetWord": target_word,
                    "completedIn": completed_in,
                    "completedFrom": completed_from,
                    "wordOptions": starter_words,
                    "leaderboard": leaderboard,
                    "previousTargetWord": previous_target_word,
                }
            )
        )

    async def broadcast_active_users(self, data):
        active_users = data["activeUsers"]
        leaderboard = data["leaderboard"]

        await self.send(
            text_data=json.dumps(
                {"activeUsers": active_users, "leaderboard": leaderboard}
            )
        )

    async def broadcast_new_word(self, data):
        await self.send(
            text_data=json.dumps(
                {
                    "targetWord": data["targetWord"],
                    "leaderboard": data["leaderboard"],
                    "completedFrom": data["completedFrom"],
                    "completedIn": data["completedIn"],
                    "previousTargetWord": data["previousTargetWord"],
                }
            )
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        username = self.scope["user"].get_username()
        # Get clicked word
        clicked_word = data["word"]
        # Add clicked word to player's path
        await self.add_word_to_player_path(username, clicked_word)
        # Get current target word
        current_target_word = await self.get_target_word()

        # if player selected final word
        if clicked_word == current_target_word:
            # Give player points
            _, num_points = await self.get_active_users()
            await self.give_player_points(username, num_points)

            # Get player path
            player_path = await self.get_player_path(username)
            completed_in = len(player_path)
            completed_from = player_path[0]

            # Update copmpleted word entry
            await self.complete_current_word(
                completed_in, completed_from, completed_path, player_path
            )

            # Set a new target word
            new_target_word = await self.set_target_word(current_target_word)

            # Get new leaderboard
            leaderboard = await self.get_leaderboard()

            group_name = "online"
            # Send message to the relevant group
            await self.channel_layer.group_send(
                group_name,
                {
                    "type": "broadcast_new_word",
                    "targetWord": new_target_word,
                    "leaderboard": leaderboard,
                    "completedFrom": completed_from,
                    "completedIn": completed_in,
                    "previousTargetWord": clicked_word,
                },
            )

        elif clicked_word != current_target_word:
            # Add clicked word to player's path
            await self.add_word_to_player_path(username, clicked_word)
            # Get new word options for the player
            player_path = await self.get_player_path(username)
            word_options = await self.get_word_options(clicked_word, player_path)

            await self.send(text_data=json.dumps({"wordOptions": word_options}))

    async def disconnect(self, close_code):
        # Get player's username
        username = self.scope["user"].get_username()
        # Remove user from group
        group_name = "online"
        await self.channel_layer.group_discard(group_name, self.channel_name)

        # Set player's logged in status in DB
        player = await self.log_player_out(username)

        # Get number of online users
        _, active_users = await self.get_active_users()

        # Send message to the relevant group
        await self.channel_layer.group_send(
            group_name, {"type": "broadcast_active_users", "activeUsers": active_users}
        )
